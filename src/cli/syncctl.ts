import readline from "node:readline";
import { config } from "../config.js";
import { db } from "../db/database.js";
import { AuthService } from "../services/auth.js";

const auth = new AuthService(db);
const args = process.argv.slice(2);

function valueOf(name: string, fallback?: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function parseTtl(input: string): number {
  const match = input.match(/^(\d+)(s|m|h)$/);
  if (!match) throw new Error("TTL must look like 30s, 10m or 1h.");
  const value = Number(match[1]);
  const unit = match[2];
  return value * (unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const rl = readline.createInterface({ input, output: undefined });
  const originalWrite = output.write.bind(output);

  try {
    output.write(prompt);
    return await new Promise<string>((resolve) => {
      rl.question("", (answer) => resolve(answer));
    });
  } finally {
    rl.close();
    originalWrite("\n");
  }
}

const [command, subcommand, action] = args;

try {
  if (command === "setup") {
    const password = valueOf("--password");
    if (!password) throw new Error("Usage: syncctl setup --password <password>");
    auth.setup(password);
    console.log("Server configured. Initial setup is enabled for the first trusted device.");
    console.log(`Database: ${config.databasePath}`);
  } else if (command === "password" && subcommand === "reset") {
    const password = valueOf("--password") ?? (await readSecret("New server password: "));
    auth.resetPassword(password);
    console.log("Server password reset.");
    console.log(`Database: ${config.databasePath}`);
  } else if (command === "password" && subcommand === "verify") {
    const password = valueOf("--password") ?? (await readSecret("Server password: "));
    if (!auth.verifyPassword(password)) {
      console.error(`Password does not match database: ${config.databasePath}`);
      process.exit(2);
    }
    console.log(`Password matches database: ${config.databasePath}`);
  } else if (command === "password" && subcommand === "http-verify") {
    const url = valueOf("--url", `http://${config.host}:${config.port}`);
    const password = valueOf("--password") ?? (await readSecret("Server password: "));
    const infoResponse = await fetch(apiUrl(url!, "/api/v1/server-info"));
    const infoText = await infoResponse.text();
    console.log(`HTTP server-info at ${url}: ${infoResponse.status} ${infoText}`);
    const response = await fetch(apiUrl(url!, "/api/v1/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password })
    });
    const text = await response.text();
    if (!response.ok) {
      console.error(`HTTP password verification failed at ${url}: ${response.status} ${text}`);
      process.exit(2);
    }
    console.log(`HTTP password verification succeeded at ${url}: ${text}`);
  } else if (command === "config" && subcommand === "show") {
    console.log(JSON.stringify({
      dataDir: config.dataDir,
      databasePath: config.databasePath,
      blobDir: config.blobDir,
      instanceId: auth.getInstanceId(),
      host: config.host,
      port: config.port
    }, null, 2));
  } else if (command === "pairing-code" && subcommand === "create") {
    const ttl = parseTtl(valueOf("--ttl", "10m")!);
    const code = auth.createRecoveryPairingCode(ttl);
    console.log(code);
  } else if (command === "initial-setup" && (subcommand === "enable" || subcommand === "disable")) {
    auth.setInitialSetup(subcommand === "enable");
    console.log(`Initial setup ${subcommand === "enable" ? "enabled" : "disabled"}.`);
  } else {
    console.log(`Usage:
  syncctl setup --password <password>
  syncctl config show
  syncctl password reset
  syncctl password reset --password <password>
  syncctl password verify
  syncctl password verify --password <password>
  syncctl password http-verify --url <server-url>
  syncctl password http-verify --url <server-url> --password <password>
  syncctl pairing-code create --ttl=10m
  syncctl initial-setup enable
  syncctl initial-setup disable`);
    process.exit(action ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
