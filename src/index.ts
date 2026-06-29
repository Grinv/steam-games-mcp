// Bin entry point. tsup prepends the `#!/usr/bin/env node` shebang.
import { start } from "./server.js";

start().catch((err: unknown) => {
  // Fatal startup error: report on stderr and exit non-zero.
  process.stderr.write(
    `[mcp-server-template] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
