import {
    CancellationToken,
    ExtensionContext,
    LanguageModelTextPart,
    LanguageModelToolInvocationOptions,
    LanguageModelToolResult,
    lm,
} from "vscode";
import {
    AgentToolOrchestrator,
    AgentToolOrchestratorDeps,
} from "../agentToolOrchestrator";
import { createMcpToolHandler, TOOL_DEFINITIONS } from "../mcp/mcpTools";

/**
 * Registers all GSL tools as native VS Code language model tools so
 * Copilot can invoke them without requiring the MCP server.
 *
 * Both this (native LM tools) and the MCP server definition provider
 * coexist intentionally — VS Code deduplicates by tool name when both
 * are active. Native tools provide zero-config OOBE for Copilot users;
 * the MCP server serves external clients (Claude Code, Codex CLI, etc.).
 */
export function registerNativeTools(
    context: ExtensionContext,
    deps: AgentToolOrchestratorDeps,
): void {
    const orchestrator = new AgentToolOrchestrator(deps);

    for (const def of TOOL_DEFINITIONS) {
        let handler;
        try {
            handler = createMcpToolHandler(def.name, orchestrator);
        } catch (e) {
            deps.console.log(
                `[registerNativeTools] Skipping tool '${def.name}': ${e instanceof Error ? e.message : String(e)}`,
            );
            continue;
        }

        context.subscriptions.push(
            lm.registerTool(def.name, {
                // TODO: thread cancellation token into tool handlers
                async invoke(
                    options: LanguageModelToolInvocationOptions<
                        Record<string, unknown>
                    >,
                    _token: CancellationToken,
                ): Promise<LanguageModelToolResult> {
                    // TODO: surface McpToolResult.isError to the caller
                    const result = await handler(options.input);
                    return new LanguageModelToolResult(
                        result.content.map(
                            (c) => new LanguageModelTextPart(c.text),
                        ),
                    );
                },
            }),
        );
    }
}
