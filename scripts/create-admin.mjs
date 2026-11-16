#!/usr/bin/env node
// create-admin: make a login for the admin app (ADR 0008). Public sign-up is off, so
// this (and later the admin UI) is how accounts are created.
//
//   npm run create-admin                         # prompts for email, name, password
//   npm run create-admin -- --email you@example.com --name "Your Name"
//   printf '%s' "$PW" | npm run create-admin -- --email … --name … --password-stdin
//   … --role social                              # default role: admin
//
// Reads ADMIN_DB_URL, BETTER_AUTH_SECRET and BETTER_AUTH_URL from the gitignored
// `.env.admin` at the repo root (npm script: node --env-file=.env.admin). Use the
// values of the environment you are creating the user in: the Neon `dev` branch's
// admin_app URL for staging, production's for production. It connects as admin_app,
// never as the owner.
//
// Steps: Better Auth admin-plugin createUser (password hashed by Better Auth), then
// the role in public.user_roles and an audit_log row in one transaction. The password
// is never echoed, logged or stored anywhere but as Better Auth's hash.

import { parseArgs } from "node:util";
import readline from "node:readline";
import { stdin, stdout, stderr } from "node:process";

const { values: args } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string", default: "admin" },
    "password-stdin": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  stdout.write("usage: npm run create-admin -- [--email E] [--name N] [--role admin|social] [--password-stdin]\n");
  process.exit(0);
}

const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

// Prompt without echoing what is typed.
const askHidden = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => {
      if (!muted) stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });

const readStdin = async () => {
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
};

async function main() {
  const { ROLES } = await import("../src/lib/admin/roles.mjs");
  if (!ROLES.includes(args.role)) throw new Error(`--role must be one of: ${ROLES.join(", ")}`);

  const interactive = stdin.isTTY && !args["password-stdin"];
  if (!args["password-stdin"] && !stdin.isTTY) {
    throw new Error("no terminal for the password prompt; pipe it in with --password-stdin");
  }

  const email = args.email ?? (interactive ? await ask("Email: ") : "");
  const name = args.name ?? (interactive ? await ask("Name: ") : "");
  if (!email || !name) throw new Error("--email and --name are required");

  let password;
  if (args["password-stdin"]) {
    password = await readStdin();
  } else {
    password = await askHidden("Password (not shown): ");
    const again = await askHidden("Password again: ");
    if (password !== again) throw new Error("passwords don't match");
  }

  // Loaded only now, so --help and argument errors need no environment.
  const { createUser, grantRole } = await import("../src/lib/admin/users.mjs");
  const { withAudit, pool } = await import("../src/lib/admin/db.mjs");
  try {
    const user = await createUser({ email, name, password });
    await withAudit(null, (client) => grantRole(client, user.id, args.role), {
      action: "user.create",
      targetTable: "auth.user",
      targetId: user.id,
      details: { email: user.email, role: args.role, via: "create-admin CLI" },
    });
    stdout.write(`Created ${user.email} (${args.role}), id ${user.id}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // Better Auth's APIError carries the useful text in body.message.
  stderr.write(`create-admin failed: ${err?.body?.message ?? err.message}\n`);
  process.exitCode = 1;
});
