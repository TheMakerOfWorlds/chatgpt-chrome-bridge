# ChatGPT Chrome Bridge

When a user shares this repository link for setup or asks to install this bridge, read and follow [docs/CODEX_SETUP.md](docs/CODEX_SETUP.md) and [docs/INSTALL.md](docs/INSTALL.md). The setup guide requires asking whether new chats should go into no project or a ChatGPT project chosen by the user. Guide the installation end to end instead of handing the user a command checklist. Ask which of their own accounts has the paid plan and Pro access, and verify the options after sign-in. Do not infer account access from a Chrome profile name.

For maintenance, preserve existing account and project preferences unless the user requests a change. Keep runtime login data outside Git and release bundles. Run `npm run check` and `npm test` for code changes. Publish versioned stable releases for managed updates; keep active jobs running.
