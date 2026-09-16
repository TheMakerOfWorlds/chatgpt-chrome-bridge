# ChatGPT Chrome Bridge

When a user asks to install or set up this bridge, read and follow [docs/CODEX_SETUP.md](docs/CODEX_SETUP.md) and [docs/INSTALL.md](docs/INSTALL.md). The setup guide requires asking whether new chats should go into no project or a ChatGPT project chosen by the user. Use only their own account.

For maintenance, preserve existing account and project preferences unless the user requests a change. Keep runtime login data outside Git and release bundles. Run `npm run check` and `npm test` for code changes. Publish versioned stable releases for managed updates; keep active jobs running.
