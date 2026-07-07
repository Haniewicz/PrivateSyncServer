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

const [command, subcommand, action] = args;

if (command === "setup") {
  const password = valueOf("--password");
  if (!password) throw new Error("Usage: syncctl setup --password <password>");
  auth.setup(password);
  console.log("Server configured. Initial setup is enabled for the first trusted device.");
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
  syncctl pairing-code create --ttl=10m
  syncctl initial-setup enable
  syncctl initial-setup disable`);
  process.exit(action ? 1 : 0);
}
