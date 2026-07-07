import readline from "node:readline";
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

async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const rl = readline.createInterface({ input, output });
  const originalWrite = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
    const text = chunk.toString();
    if (text.includes(prompt) || text === "\n" || text === "\r\n") {
      return originalWrite(chunk, encoding, callback);
    }
    return originalWrite("*".repeat([...text].length), encoding, callback);
  }) as typeof output.write;

  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
  } finally {
    output.write = originalWrite;
    rl.close();
    output.write("\n");
  }
}

const [command, subcommand, action] = args;

try {
  if (command === "setup") {
    const password = valueOf("--password");
    if (!password) throw new Error("Usage: syncctl setup --password <password>");
    auth.setup(password);
    console.log("Server configured. Initial setup is enabled for the first trusted device.");
  } else if (command === "password" && subcommand === "reset") {
    const password = valueOf("--password") ?? (await readSecret("New server password: "));
    auth.resetPassword(password);
    console.log("Server password reset.");
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
  syncctl password reset
  syncctl password reset --password <password>
  syncctl pairing-code create --ttl=10m
  syncctl initial-setup enable
  syncctl initial-setup disable`);
    process.exit(action ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
