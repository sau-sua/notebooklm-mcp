/**
 * MCP server factory
 *
 * Builds a fully wired MCP `Server` (tools + resources) over the shared
 * managers. The stdio entry point builds one; the Streamable HTTP transport
 * builds one per client session, because an SDK `Server` can only be
 * connected to a single transport.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  // CompleteRequestSchema, // Disabled for Claude Desktop compatibility
  Tool,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';

import { NotebookLibrary } from '../library/notebook-library.js';
import { ToolHandlers, buildToolDefinitions } from '../tools/index.js';
import { CANONICAL_TO_LEGACY } from '../tools/tool-names.js';
import type { SourceFormat } from '../types.js';
import { log } from '../utils/logger.js';

export type AskQuestionArgs = {
  question: string;
  session_id?: string;
  notebook_id?: string;
  notebook_url?: string;
  show_browser?: boolean;
  source_format?: SourceFormat;
};

/**
 * Job-based ask: `notebook_ask` starts a job and `notebook_ask_result` polls
 * it, so no tool call outlives a client's tool timeout.
 */
export interface AsyncAsk {
  /** Start a question in the background and return its job id. */
  start(args: AskQuestionArgs): string;
  /** Job status (`pending` | `done` | `error`), waiting a bounded time while pending. */
  result(jobId: string): Promise<{ status?: unknown; error?: unknown }>;
}

export interface McpServerDeps {
  toolHandlers: ToolHandlers;
  library: NotebookLibrary;
  /** When set, ask through jobs; otherwise `notebook_ask` blocks until answered. */
  asyncAsk?: AsyncAsk;
}

export function buildMcpToolDefinitions(library: NotebookLibrary, asyncAsk: boolean): Tool[] {
  return buildToolDefinitions(library, { asyncAsk }) as Tool[];
}

function unknownTool(name: string) {
  log.error(`❌ [MCP] Unknown tool: ${name}`);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            success: false,
            error: `Unknown tool: ${name}`,
          },
          null,
          2
        ),
      },
    ],
  };
}

export function createMcpServer(deps: McpServerDeps, version: string): Server {
  const { toolHandlers, library, asyncAsk } = deps;
  const toolDefinitions = buildMcpToolDefinitions(library, asyncAsk !== undefined);

  const server = new Server(
    {
      name: 'notebooklm-mcp',
      version,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log.info('📋 [MCP] list_tools request received');
    return {
      tools: toolDefinitions,
    };
  });

  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    log.info('📚 [MCP] list_resources request received');

    const notebooks = library.listNotebooks();
    const resources: Resource[] = [
      {
        uri: 'notebooklm://library',
        name: 'Notebook Library',
        description:
          'Complete notebook library with all available knowledge sources. ' +
          'Read this to discover what notebooks are available. ' +
          "⚠️ If you think a notebook might help with the user's task, " +
          'ASK THE USER FOR PERMISSION before consulting it: ' +
          "'Should I consult the [notebook] for this task?'",
        mimeType: 'application/json',
      },
    ];

    // Add individual notebook resources
    for (const notebook of notebooks) {
      resources.push({
        uri: `notebooklm://library/${notebook.id}`,
        name: notebook.name,
        description:
          `${notebook.description} | Topics: ${notebook.topics.join(', ')} | ` +
          `💡 Use ask_question to query this notebook (ask user permission first if task isn't explicitly about these topics)`,
        mimeType: 'application/json',
      });
    }

    // Add legacy metadata resource for backwards compatibility
    const active = library.getActiveNotebook();
    if (active) {
      resources.push({
        uri: 'notebooklm://metadata',
        name: 'Active Notebook Metadata (Legacy)',
        description:
          'Information about the currently active notebook. ' +
          'DEPRECATED: Use notebooklm://library instead for multi-notebook support. ' +
          "⚠️ Always ask user permission before using notebooks for tasks they didn't explicitly mention.",
        mimeType: 'application/json',
      });
    }

    return { resources };
  });

  // List resource templates
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    log.info('📑 [MCP] list_resource_templates request received');

    return {
      resourceTemplates: [
        {
          uriTemplate: 'notebooklm://library/{id}',
          name: 'Notebook by ID',
          description:
            'Access a specific notebook from your library by ID. ' +
            'Provides detailed metadata about the notebook including topics, use cases, and usage statistics. ' +
            "💡 Use the 'id' parameter from list_notebooks to access specific notebooks.",
          mimeType: 'application/json',
        },
      ],
    };
  });

  // Read resource content
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    log.info(`📖 [MCP] read_resource request: ${uri}`);

    // Handle library resource
    if (uri === 'notebooklm://library') {
      const notebooks = library.listNotebooks();
      const stats = library.getStats();
      const active = library.getActiveNotebook();

      const libraryData = {
        active_notebook: active
          ? {
              id: active.id,
              name: active.name,
              description: active.description,
              topics: active.topics,
            }
          : null,
        notebooks: notebooks.map((nb) => ({
          id: nb.id,
          name: nb.name,
          description: nb.description,
          topics: nb.topics,
          content_types: nb.content_types,
          use_cases: nb.use_cases,
          url: nb.url,
          use_count: nb.use_count,
          last_used: nb.last_used,
          tags: nb.tags,
        })),
        stats,
      };

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(libraryData, null, 2),
          },
        ],
      };
    }

    // Handle individual notebook resource
    if (uri.startsWith('notebooklm://library/')) {
      const prefix = 'notebooklm://library/';
      const encodedId = uri.slice(prefix.length);
      if (!encodedId) {
        throw new Error('Notebook resource requires an ID (e.g. notebooklm://library/{id})');
      }

      let id: string;
      try {
        id = decodeURIComponent(encodedId);
      } catch {
        throw new Error(`Invalid notebook identifier encoding: ${encodedId}`);
      }

      if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(id)) {
        throw new Error(
          `Invalid notebook identifier: ${encodedId}. Notebook IDs may only contain letters, numbers, and hyphens.`
        );
      }

      const notebook = library.getNotebook(id);

      if (!notebook) {
        throw new Error(`Notebook not found: ${id}`);
      }

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(notebook, null, 2),
          },
        ],
      };
    }

    // Legacy metadata resource (backwards compatibility)
    if (uri === 'notebooklm://metadata') {
      const active = library.getActiveNotebook();

      if (!active) {
        throw new Error('No active notebook. Use notebooklm://library to see all notebooks.');
      }

      const metadata = {
        description: active.description,
        topics: active.topics,
        content_types: active.content_types,
        use_cases: active.use_cases,
        notebook_url: active.url,
        notebook_id: active.id,
        last_used: active.last_used,
        use_count: active.use_count,
        note: 'DEPRECATED: Use notebooklm://library or notebooklm://library/{id} instead',
      };

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(metadata, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // Argument completions (for prompt arguments)
  // Note: Completions are optional and not supported by all MCP clients (e.g., Claude Desktop)
  // We skip registering this handler to maintain compatibility
  // server.setRequestHandler(CompleteRequestSchema, async (request) => {
  //   const { ref, argument } = request.params as any;
  //   try {
  //     if (ref?.type === "ref/resource") {
  //       // Complete variables for resource templates
  //       const uri = String(ref.uri || "");
  //       // Notebook by ID template
  //       if (uri === "notebooklm://library/{id}" && argument?.name === "id") {
  //         const values = this.completeNotebookIds(argument?.value);
  //         return this.buildCompletion(values) as any;
  //       }
  //     }
  //   } catch (e) {
  //     log.warning(`⚠️  [MCP] completion error: ${e}`);
  //   }
  //   return { completion: { values: [], total: 0 } } as any;
  // });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: requestedName, arguments: args } = request.params;
    // v2 tools are advertised under canonical (v2) names
    // (e.g. `notebook_ask`). The dispatch switch and handlers still use the
    // legacy flat names internally — and legacy names remain accepted as
    // aliases, so existing integrations keep working.
    const name = CANONICAL_TO_LEGACY[requestedName] ?? requestedName;
    const progressToken = (args as Record<string, unknown> | undefined)?._meta as
      | { progressToken?: string }
      | undefined;
    const token = progressToken?.progressToken;

    log.info(`🔧 [MCP] Tool call: ${name}`);
    if (token) {
      log.info(`  📊 Progress token: ${token}`);
    }

    // Create progress callback function
    const sendProgress = async (message: string, progress?: number, total?: number) => {
      if (token) {
        await server.notification({
          method: 'notifications/progress',
          params: {
            progressToken: token,
            message,
            ...(progress !== undefined && { progress }),
            ...(total !== undefined && { total }),
          },
        });
        log.dim(`  📊 Progress: ${message}`);
      }
    };

    try {
      let result;

      switch (name) {
        case 'ask_question':
          if (asyncAsk) {
            const askArgs = args as AskQuestionArgs;
            result = askArgs?.question
              ? { success: true, data: { job_id: asyncAsk.start(askArgs), status: 'pending' } }
              : { success: false, error: 'Missing required field: question' };
            break;
          }
          result = await toolHandlers.handleAskQuestion(args as AskQuestionArgs, sendProgress);
          break;

        case 'ask_question_result': {
          if (!asyncAsk) return unknownTool(name);
          const jobId = (args as { job_id?: unknown } | undefined)?.job_id;
          if (typeof jobId !== 'string' || !jobId) {
            result = { success: false, error: 'Missing required field: job_id' };
            break;
          }
          const job = await asyncAsk.result(jobId);
          result =
            job.status === 'error'
              ? { success: false, error: String(job.error ?? 'error'), data: job }
              : { success: true, data: job };
          break;
        }

        case 'batch_to_vault':
          result = await toolHandlers.handleBatchToVault(
            args as {
              questions: string[];
              vault_dir: string;
              notebook_id?: string;
              notebook_url?: string;
              slug_prefix?: string;
              source_format?: 'none' | 'inline' | 'footnotes' | 'json' | 'expanded';
              sleep_between_ms?: number;
              session_id?: string;
            }
          );
          break;

        case 'auto_discover_notebook':
          result = await toolHandlers.handleAutoDiscoverNotebook(args as { url: string });
          break;

        case 'add_notebook':
          result = await toolHandlers.handleAddNotebook(
            args as {
              url: string;
              name: string;
              description: string;
              topics: string[];
              content_types?: string[];
              use_cases?: string[];
              tags?: string[];
            }
          );
          break;

        case 'list_notebooks':
          result = await toolHandlers.handleListNotebooks();
          break;

        case 'get_notebook':
          result = await toolHandlers.handleGetNotebook(args as { id: string });
          break;

        case 'select_notebook':
          result = await toolHandlers.handleSelectNotebook(args as { id: string });
          break;

        case 'update_notebook':
          result = await toolHandlers.handleUpdateNotebook(
            args as {
              id: string;
              name?: string;
              description?: string;
              topics?: string[];
              content_types?: string[];
              use_cases?: string[];
              tags?: string[];
              url?: string;
            }
          );
          break;

        case 'remove_notebook':
          result = await toolHandlers.handleRemoveNotebook(args as { id: string });
          break;

        case 'search_notebooks':
          result = await toolHandlers.handleSearchNotebooks(args as { query: string });
          break;

        case 'get_library_stats':
          result = await toolHandlers.handleGetLibraryStats();
          break;

        case 'list_sessions':
          result = await toolHandlers.handleListSessions();
          break;

        case 'close_session':
          result = await toolHandlers.handleCloseSession(args as { session_id: string });
          break;

        case 'reset_session':
          result = await toolHandlers.handleResetSession(args as { session_id: string });
          break;

        case 'get_health':
          result = await toolHandlers.handleGetHealth();
          break;

        case 'setup_auth':
          result = await toolHandlers.handleSetupAuth(
            args as { show_browser?: boolean },
            sendProgress
          );
          break;

        case 'de_auth':
          result = await toolHandlers.handleDeAuth();
          break;

        case 're_auth':
          result = await toolHandlers.handleReAuth(
            args as { show_browser?: boolean },
            sendProgress
          );
          break;

        case 'cleanup_data':
          result = await toolHandlers.handleCleanupData(args as { confirm: boolean });
          break;

        // Content Management Tools
        case 'add_source':
          result = await toolHandlers.handleAddSource(
            args as {
              source_type: 'file' | 'url' | 'text' | 'youtube' | 'google_drive';
              file_path?: string;
              url?: string;
              text?: string;
              title?: string;
              notebook_url?: string;
              session_id?: string;
            }
          );
          break;

        case 'delete_source':
          result = await toolHandlers.handleDeleteSource(
            args as {
              source_id?: string;
              source_name?: string;
              notebook_url?: string;
              session_id?: string;
            }
          );
          break;

        case 'list_sources':
          result = await toolHandlers.handleListSources(
            args as { notebook_url?: string; notebook_id?: string }
          );
          break;

        case 'read_source':
          result = await toolHandlers.handleReadSource(
            args as {
              source_id?: string;
              source_name?: string;
              notebook_url?: string;
              notebook_id?: string;
              format?: 'text' | 'html';
              paginate?: boolean;
              max_chars?: number;
              cursor?: number;
            }
          );
          break;

        case 'delete_content':
          result = await toolHandlers.handleDeleteContent(
            args as { content_id: string; notebook_url?: string; notebook_id?: string }
          );
          break;

        case 'generate_content':
          result = await toolHandlers.handleGenerateContent(
            args as {
              content_type: 'audio_overview';
              custom_instructions?: string;
              notebook_url?: string;
              session_id?: string;
            }
          );
          break;

        case 'list_content':
          result = await toolHandlers.handleListContent(
            args as {
              notebook_url?: string;
              session_id?: string;
            }
          );
          break;

        case 'download_content':
          result = await toolHandlers.handleDownloadContent(
            args as {
              content_type:
                | 'audio_overview'
                | 'video'
                | 'infographic'
                | 'presentation'
                | 'data_table';
              output_path?: string;
              notebook_url?: string;
              session_id?: string;
            }
          );
          break;

        case 'create_note':
          result = await toolHandlers.handleCreateNote(
            args as {
              title: string;
              content: string;
              notebook_url?: string;
              session_id?: string;
            }
          );
          break;

        case 'list_notes':
          result = await toolHandlers.handleListNotes(
            args as {
              notebook_url?: string;
              session_id?: string;
            }
          );
          break;

        case 'get_note':
          result = await toolHandlers.handleGetNote(
            args as {
              note_title: string;
              note_id?: string;
              notebook_url?: string;
              session_id?: string;
            }
          );
          break;

        case 'save_chat_to_note':
          result = await toolHandlers.handleSaveChatToNote(
            args as {
              title?: string;
              notebook_url?: string;
              session_id?: string;
            }
          );
          break;

        case 'convert_note_to_source':
          result = await toolHandlers.handleConvertNoteToSource(
            args as {
              note_title: string;
              notebook_url?: string;
              session_id?: string;
            }
          );
          break;

        case 'list_notebooks_from_nblm':
          result = await toolHandlers.handleListNotebooksFromNblm(
            args as { show_browser?: boolean },
            sendProgress
          );
          break;

        case 'create_notebook':
          result = await toolHandlers.handleCreateNotebook(
            args as { name?: string; show_browser?: boolean },
            sendProgress
          );
          break;

        case 'delete_notebooks_from_nblm':
          result = await toolHandlers.handleDeleteNotebooksFromNblm(
            args as { notebook_ids: string[]; show_browser?: boolean },
            sendProgress
          );
          break;

        case 'share_notebook':
          result = await toolHandlers.handleNotebookSharing(
            args as { notebook_url?: string; notebook_id?: string; set_public?: boolean }
          );
          break;

        case 'generate_study_aid':
          result = await toolHandlers.handleGenerateStudyAid(
            args as {
              notebook_url?: string;
              notebook_id?: string;
              kind: 'flashcards' | 'quiz';
              focus?: string;
              language?: string;
            }
          );
          break;

        case 'generate_mind_map':
          result = await toolHandlers.handleGenerateMindMap(
            args as {
              notebook_url?: string;
              notebook_id?: string;
              title?: string;
              language?: string;
              focus?: string;
            }
          );
          break;

        case 'manage_labels':
          result = await toolHandlers.handleLabels(
            args as {
              notebook_url?: string;
              notebook_id?: string;
              action?: 'list' | 'create' | 'delete';
              name?: string;
              emoji?: string;
              label_ids?: string[];
            }
          );
          break;

        case 'research_sources':
          result = await toolHandlers.handleResearchSources(
            args as {
              notebook_url?: string;
              notebook_id?: string;
              query: string;
              import?: boolean;
            }
          );
          break;

        default:
          return unknownTool(name);
      }

      // Return result — both as text (for display) and as structuredContent
      // (matching each tool's outputSchema: the ToolResult envelope).
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [MCP] Tool execution error: ${errorMessage}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: errorMessage,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  });

  return server;
}
