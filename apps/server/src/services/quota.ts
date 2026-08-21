import type { Package, QuotaDecision, RelayRule, RuleQuotaStatus, User, UserSubscription } from "@tyz/shared";
import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db";
import { packages, relayRules, userPackages, users } from "../db/schema";

/**
 * Package/subscription enforcement shared by the config aggregator and the
 * admin API.
 *
 * Division of labor: the server is the billing ledger (usage is aggregated
 * from gost_stats snapshots), the agent is the enforcement point (its in-path
 * quota blocks at the remaining allowance pushed with the config). A rule is
 * EXCLUDED from the node config — a hard stop — when its owner has no usable
 * allowance left (disabled user, no subscription, expired subscription, or
 * exhausted traffic).
 *
 * The allowance is per USER, shared by every rule they own: all of a user's
 * rules reference one quota object (`quota-user-{id}`); GOST quotas with the
 * same name share a single counter, so rules on the same node count against
 * one budget. Rules spread across several nodes each get the same remaining
 * limit and count independently until the next recompute tightens it — the
 * ledger stays exact; in-path enforcement can overshoot by at most one
 * recompute interval of cross-node traffic.
 */

export interface ActiveSubscription {
  subscription: UserSubscription;
  pkg: Package;
  expired: boolean;
}

/** Load the active subscription (latest row; one per user by UNIQUE) per user id. */
export async function getActiveSubscriptions(
  db: Database,
  userIds: number[],
): Promise<Map<number, ActiveSubscription>> {
  const out = new Map<number, ActiveSubscription>();
  if (userIds.length === 0) return out;

  const rows = await db
    .select({ subscription: userPackages, pkg: packages })
    .from(userPackages)
    .innerJoin(packages, eq(packages.id, userPackages.package_id))
    .where(inArray(userPackages.user_id, userIds))
    .orderBy(userPackages.id);

  const now = new Date().toISOString();
  for (const row of rows) {
    out.set(row.subscription.user_id, {
      subscription: row.subscription,
      pkg: {
        ...row.pkg,
        note: row.pkg.note ?? undefined,
        node_ids: row.pkg.node_ids ?? null,
        tunnel_ids: row.pkg.tunnel_ids ?? null,
      },
      expired: row.subscription.expires_at !== null && row.subscription.expires_at <= now,
    });
  }
  return out;
}

export async function getUserStatuses(db: Database, userIds: number[]): Promise<Map<number, User>> {
  const out = new Map<number, User>();
  if (userIds.length === 0) return out;
  const rows = await db.select().from(users).where(inArray(users.id, userIds));
  for (const row of rows) {
    out.set(row.id, { ...row, note: row.note ?? undefined });
  }
  return out;
}

/**
 * CHARGED bytes used by one rule since `sinceIso`, from the hourly traffic
 * ledger (billing source of truth — ingest-time UPSERT accumulation of
 * round(real × node rate)). The window start is floored to its containing
 * hour, so at most one hour of pre-window traffic is included: a
 * conservative, one-time-per-window overcount that never over-delivers
 * allowance. Rules deleted mid-window keep their ledger rows (no FK by
 * design).
 */
export async function ruleUsageBytes(db: Database, ruleId: number, sinceIso: string): Promise<number> {
  const result = (await db.get(sql`
    SELECT COALESCE(SUM(billed_upload + billed_download), 0) AS used
    FROM traffic_hourly
    WHERE rule_id = ${ruleId} AND hour_ts >= ${`${sinceIso.slice(0, 13)}:00:00.000Z`}
  `)) as { used: number | null } | undefined;
  return Number(result?.used ?? 0);
}

/** Resolve allowance decisions for a set of users in one batch (admin lists). */
export async function quotaDecisionsForUsers(db: Database, userIds: number[]): Promise<Map<number, QuotaDecision>> {
  const out = new Map<number, QuotaDecision>();
  if (userIds.length === 0) return out;
  const [userById, subByUser] = await Promise.all([getUserStatuses(db, userIds), getActiveSubscriptions(db, userIds)]);
  for (const id of userIds) {
    out.set(id, await quotaForUser(db, userById.get(id), subByUser.get(id)));
  }
  return out;
}

/**
 * Resolve one user's allowance. Usage is summed over ALL of the user's rules
 * (across nodes — the ledger follows the rule, not the node it currently
 * serves on).
 */
async function quotaForUser(
  db: Database,
  user: User | undefined,
  sub: ActiveSubscription | undefined,
): Promise<QuotaDecision> {
  if (!user || user.status !== "active") return { stopped: true, reason: "user_disabled" };
  if (!sub) return { stopped: true, reason: "no_subscription" };
  if (sub.expired) return { stopped: true, reason: "expired" };
  if (sub.pkg.traffic_bytes <= 0) return { stopped: false }; // unlimited traffic: nothing to enforce

  let used = 0;
  const owned = await db.select({ id: relayRules.id }).from(relayRules).where(eq(relayRules.user_id, user.id));
  for (const { id } of owned) {
    used += await ruleUsageBytes(db, id, sub.subscription.activated_at);
  }
  const remaining = sub.pkg.traffic_bytes - used;
  if (remaining <= 0) return { stopped: true, reason: "exhausted" };

  return {
    stopped: false,
    quota: {
      name: `quota-user-${user.id}`,
      limit_bytes: remaining,
      starts_at: sub.subscription.activated_at,
      expires_at: sub.subscription.expires_at ?? undefined,
    },
  };
}

/**
 * Filter and enrich rules for a node config: rules whose owner has no usable
 * allowance are dropped (hard stop, self-healing on every recompute); rules
 * with a metered package get the owner's shared quota with the remaining
 * allowance.
 */
export async function applyRuleQuotas(db: Database, rules: RelayRule[]): Promise<RelayRule[]> {
  const userIds = [...new Set(rules.map((r) => r.user_id).filter((id): id is number => id !== undefined))];
  if (userIds.length === 0) return rules;

  const [userById, subByUser] = await Promise.all([getUserStatuses(db, userIds), getActiveSubscriptions(db, userIds)]);
  const decisionByUser = new Map<number, QuotaDecision>();
  for (const id of userIds) {
    decisionByUser.set(id, await quotaForUser(db, userById.get(id), subByUser.get(id)));
  }

  const out: RelayRule[] = [];
  for (const rule of rules) {
    if (rule.user_id === undefined) {
      out.push(rule); // admin-managed rule: never quota-gated
      continue;
    }
    const decision = decisionByUser.get(rule.user_id);
    if (!decision || decision.stopped) continue;
    out.push(decision.quota ? { ...rule, quota: decision.quota } : rule);
  }
  return out;
}

/** Admin-facing usage summary for one user. */
export async function userQuotaSummary(
  db: Database,
  user: User,
  rules: RelayRule[],
): Promise<{ subscription: ActiveSubscription | null; decision: QuotaDecision; rules: RuleQuotaStatus[] }> {
  const sub = (await getActiveSubscriptions(db, [user.id])).get(user.id) ?? null;
  const decision = await quotaForUser(db, user, sub ?? undefined);
  const statuses: RuleQuotaStatus[] = [];
  for (const rule of rules) {
    statuses.push({
      rule_id: rule.id,
      rule_name: rule.name,
      used_bytes:
        sub && sub.pkg.traffic_bytes > 0 ? await ruleUsageBytes(db, rule.id, sub.subscription.activated_at) : 0,
    });
  }
  return { subscription: sub, decision, rules: statuses };
}
