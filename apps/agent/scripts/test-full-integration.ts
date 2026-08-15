/**
 * 完整集成测试：生成配置 -> 写入文件 -> 启动 GOST
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeConfigData } from "@tyz/shared";
import { generateGostConfig } from "../src/services/gost/builder";

const GOST_BINARY = process.env.GOST_BINARY ?? "/home/guyuels/workspace/laoshan/gost-binary/gost";
const CONFIG_FILE = join(process.cwd(), "generated-gost-config.json");

async function main() {
  try {
    console.log("========================================");
    console.log("GOST 完整集成测试");
    console.log("========================================\n");

    // 1. 读取示例数据
    console.log("1. 读取示例数据...");
    const examplePath = join(__dirname, "../../../examples/real-database-example.json");
    const content = await readFile(examplePath, "utf-8");
    const example = JSON.parse(content);
    const configData: NodeConfigData = example.aggregated_data;

    console.log("   ✓ 节点:", configData.node.name);
    console.log("   ✓ 规则数:", configData.rules.length);

    // 2. 生成 GOST 配置
    console.log("\n2. 生成 GOST 配置...");
    const gostConfig = generateGostConfig(configData);

    // 添加 API 配置
    gostConfig.api = {
      addr: ":18080",
      pathPrefix: "/api",
      accesslog: false,
    };

    console.log("   ✓ 服务数:", gostConfig.services?.length || 0);
    console.log("   ✓ 链数:", gostConfig.chains?.length || 0);
    console.log(
      "   ✓ 限速器总数:",
      (gostConfig.limiters?.length || 0) + (gostConfig.rlimiters?.length || 0) + (gostConfig.climiters?.length || 0),
    );

    // 3. 写入配置文件
    console.log("\n3. 写入配置文件...");
    await writeFile(CONFIG_FILE, JSON.stringify(gostConfig, null, 2));
    console.log("   ✓ 配置已写入:", CONFIG_FILE);

    // 4. 启动 GOST
    console.log("\n4. 启动 GOST...");
    const gost = spawn(GOST_BINARY, ["-C", CONFIG_FILE, "-D"], {
      stdio: "pipe",
      detached: false,
    });

    let startupOutput = "";
    const startupTimeout = setTimeout(() => {
      console.log("\n   启动超时，检查输出:");
      console.log(startupOutput);
    }, 5000);

    gost.stdout?.on("data", (data) => {
      startupOutput += data.toString();
    });

    gost.stderr?.on("data", (data) => {
      startupOutput += data.toString();
    });

    // 等待启动
    await new Promise((resolve) => setTimeout(resolve, 3000));
    clearTimeout(startupTimeout);

    console.log("   ✓ GOST 已启动 (PID:", gost.pid, ")");

    // 5. 验证 GOST API
    console.log("\n5. 验证 GOST API...");
    const response = await fetch("http://localhost:18080/api/config");
    if (!response.ok) {
      throw new Error("GOST API 未响应");
    }

    const config = (await response.json()) as any;
    console.log("   ✓ API 连接成功");
    console.log("   ✓ 运行中的服务数:", config.services?.length || 0);
    console.log("   ✓ 运行中的链数:", config.chains?.length || 0);

    // 6. 显示服务状态
    if (config.services && config.services.length > 0) {
      console.log("\n6. 服务状态:");
      for (const service of config.services) {
        const status = service.status?.state || "unknown";
        const events = service.status?.events || [];
        console.log(`\n   ${service.name} (${service.addr}):`);
        console.log(`     状态: ${status}`);
        if (events.length > 0) {
          const lastEvent = events[events.length - 1];
          console.log(`     最后事件: ${lastEvent.msg}`);
        }
      }
    }

    // 7. 显示链信息
    if (config.chains && config.chains.length > 0) {
      console.log("\n7. 链配置:");
      for (const chain of config.chains) {
        console.log(`\n   ${chain.name}:`);
        console.log(`     跳数: ${chain.hops?.length || 0}`);
        if (chain.hops && chain.hops.length > 0) {
          for (const hop of chain.hops) {
            const node = hop.nodes?.[0];
            if (node) {
              console.log(`       - ${node.name}: ${node.addr} (${node.dialer?.type})`);
            }
          }
        }
      }
    }

    console.log("\n========================================");
    console.log("✓ 集成测试成功！");
    console.log("========================================\n");

    console.log("GOST 正在运行，你可以:");
    console.log("  • 查看配置: curl http://localhost:18080/api/config");
    console.log("  • 停止 GOST: kill", gost.pid);
    console.log("  • 查看配置文件:", CONFIG_FILE);
    console.log("");

    // 保持进程运行，等待用户手动停止
    process.on("SIGINT", () => {
      console.log("\n停止 GOST...");
      gost.kill();
      process.exit(0);
    });
  } catch (error) {
    console.error("\n✗ 测试失败:", error);
    if (error instanceof Error) {
      console.error("  错误详情:", error.message);
    }
    process.exit(1);
  }
}

main();
