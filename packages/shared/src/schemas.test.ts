import { describe, expect, test } from "bun:test";
import { agentStatsBatchSchema } from "./schemas";

describe("agentStatsBatchSchema", () => {
  test("accepts a nil-samples idle flush (Go marshals nil slices as null)", () => {
    const parsed = agentStatsBatchSchema.safeParse({
      samples: null,
      health: [{ service: "service-1", state: "running" }],
    });
    expect(parsed.success).toBeTrue();
    if (parsed.success) {
      expect(parsed.data.samples).toEqual([]);
      expect(parsed.data.health).toHaveLength(1);
    }
  });

  test("accepts a health-only flush with samples absent", () => {
    const parsed = agentStatsBatchSchema.safeParse({
      health: [{ service: "service-1", state: "ready" }],
    });
    expect(parsed.success).toBeTrue();
    if (parsed.success) {
      expect(parsed.data.samples).toEqual([]);
    }
  });

  test("accepts null health alongside real samples", () => {
    const parsed = agentStatsBatchSchema.safeParse({
      samples: [
        {
          service: "service-1",
          totalConns: 1,
          currentConns: 0,
          inputBytes: 100,
          outputBytes: 200,
          totalErrs: 0,
        },
      ],
      health: null,
    });
    expect(parsed.success).toBeTrue();
    if (parsed.success) {
      expect(parsed.data.samples).toHaveLength(1);
      expect(parsed.data.health).toEqual([]);
    }
  });

  test("rejects an entirely empty batch", () => {
    expect(agentStatsBatchSchema.safeParse({ samples: null, health: null }).success).toBeFalse();
  });

  test("rejects malformed sample entries instead of silently dropping them", () => {
    const parsed = agentStatsBatchSchema.safeParse({
      samples: [{ service: "service-1", totalConns: -1 }],
    });
    expect(parsed.success).toBeFalse();
  });
});
