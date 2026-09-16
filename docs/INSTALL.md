# Install on a Mac

The bridge runs locally on **macOS** (Apple Silicon or Intel) using Google Chrome and Codex. Windows and Linux are not supported by this release. Your ChatGPT account must have access to the effort options you request. It uses the ChatGPT website; an OpenAI API key is not needed.

## Let Codex guide setup

Paste the setup prompt from [the README](../README.md) into Codex. The [Codex setup guide](CODEX_SETUP.md), linked from the repository's AGENTS.md, instructs Codex to ask which local Chrome profile to use and whether new chats should go into **no project** or a project in your own ChatGPT account. If you choose a project, open it on ChatGPT and paste its URL. Your computer's Codex folder is separate from a ChatGPT project.

No GitHub login is required to download this public repository or its releases. Your ChatGPT sign-in stays on your Mac; it is not supplied by the project author.

## First installation

1. Install [Google Chrome](https://www.google.com/chrome/) and open it once. Create or choose the Chrome profile you want to use with ChatGPT.
2. Install [Node.js 22 LTS](https://nodejs.org/) and [Codex](https://developers.openai.com/codex/cli). If `codex` is not available in Terminal, run `npm install -g @openai/codex`.
3. Download this repository using **Code → Download ZIP**, extract it, then open **Setup.command**. Alternatively, use Terminal:

   ```sh
   git clone https://github.com/TheMakerOfWorlds/chatgpt-chrome-bridge.git
   cd chatgpt-chrome-bridge
   sh install.sh
   ```

4. Choose your Chrome profile when prompted. The installer first checks whether its isolated session is already signed in. If needed, it opens a dedicated Chrome window for normal ChatGPT login. Complete login yourself, including any MFA, then quit that dedicated Chrome instance with **Command-Q** and press Return in Terminal. The installer verifies the login and available effort settings.
5. Choose where new chats should go. Press Return for **no project** on a fresh install, or paste a project URL from your own ChatGPT account. On a reinstall, Return keeps your existing destination; type `none` to clear it.
6. Start a **new Codex task** and say: “Use ChatGPT to help me with this.”

The installer downloads the latest stable GitHub release, installs locked dependencies, registers its own Codex marketplace, and enables automatic updates. Your existing profile, project destination, and login settings are preserved on subsequent runs. New users are asked for a destination, with no project as the default. Codex-led setup asks in the conversation and passes that choice to the installer.

For a private fork, only invited GitHub users can download it; run `gh auth login` with an authorized GitHub account first. ChatGPT sign-in and GitHub access are separate.

## Choose or change the default project

Tell Codex **“Use no project for new ChatGPT bridge chats”** or **“Use this ChatGPT project by default: [project URL].”** It saves the preference on this Mac. Existing conversations stay where they are, and updates keep the preference.

For setup from Codex or an unattended installer, pass the user's explicit choice:

```sh
sh install.sh --no-project
# Or use the project URL the user supplied:
sh install.sh --project-url 'https://chatgpt.com/g/g-p-example/project'
```

After installation, the printed maintenance command can change it without reinstalling:

```sh
BRIDGE="$HOME/Library/Application Support/ChatGPT Chrome Bridge/application/bridge"
"$BRIDGE" project                 # asks interactively
"$BRIDGE" project --no-project
"$BRIDGE" project --project-url 'https://chatgpt.com/g/g-p-example/project'
"$BRIDGE" doctor                  # shows the saved destination
```

Replace the example URL with a project you can access in the signed-in ChatGPT account. The bridge validates URL format; saving a link is not an account-access check. A noninteractive setup with no explicit project choice preserves the current setting and tells Codex to ask the user, rather than silently selecting a project.

## Updates and rollback

Automatic updates check GitHub at startup and once every six hours while the bridge is running. Only published stable releases are installed; pushing an ordinary source commit does not update clients. Downloads are size-limited and SHA-256 checked, files are validated, dependencies are installed in a separate release directory, and a startup health check passes before Codex is switched to the new version. Running jobs stay on their loaded code; new tasks load the updated plugin.

In Codex, say **“Check for ChatGPT bridge updates”** or **“Update the ChatGPT bridge.”** Status includes the installed version, last check, available version, and any update error. An unavailable GitHub server does not stop your installed bridge.

The installer prints a permanent maintenance command. At the standard location:

```sh
BRIDGE="$HOME/Library/Application Support/ChatGPT Chrome Bridge/application/bridge"
"$BRIDGE" doctor
"$BRIDGE" login
"$BRIDGE" check
"$BRIDGE" update
"$BRIDGE" rollback
"$BRIDGE" auto-off
"$BRIDGE" auto-on
```

Rollback selects the previous release for new tasks and turns automatic updates off until you explicitly re-enable them. Login state and downloaded files live outside release folders and survive updates and rollback. A failed update keeps the previous version usable. Setup can be rerun safely.

To opt out during installation: `sh install.sh --manual-updates`. For an unattended install with an existing login: `sh install.sh --skip-login`. To select an exact profile: `sh install.sh --profile 'Profile 2'`.

## Troubleshooting

- **“Node.js required”**: Install Node.js 22 LTS, reopen Terminal, and rerun setup.
- **“Codex CLI required”**: Run `npm install -g @openai/codex`, or pass `--codex /absolute/path/to/codex`.
- **“Open Google Chrome once”**: Chrome needs to create its profile metadata before setup can list profiles.
- **Login window closes immediately / profile locked**: Quit the dedicated bridge Chrome instance completely; closing a tab alone is insufficient. Run the login command again.
- **macOS will not open Setup.command**: Open Terminal in the extracted folder and run `sh install.sh`.
- **GitHub release unavailable**: Check connectivity and repository access. A private repo requires `gh auth login`; a new fork needs its first published release and a changed repository identifier in the code.
- **Tools have not changed after update**: Start a new Codex task. Existing tasks deliberately keep their loaded version.
- **An old personal install is also enabled**: Setup normally disables it for new tasks through Codex while retaining its files for existing workers. If migration reports a warning, disable the personal copy in Codex Plugins and keep `chatgpt-bridge-releases` enabled. Once its old jobs finish, you may uninstall the personal copy. Login state is stored separately.

The bridge maintains small disposable browser caches automatically. Saved output files and protected login state are not deleted by storage cleanup.

## Browser window preference

The supported default is **background**: a normal Chrome window is positioned off-screen so the worker does not take focus. Ask Codex to configure the bridge for background operation (`headless: true`, the legacy parameter name) or visible operation (`headless: false`). Login always opens an ordinary visible Chrome window.

That legacy parameter does not mean true windowless Chrome. A September 16, 2026 experiment using `--headless=new` on both Macs repeatedly stopped at ChatGPT's browser-check page, while normal background Chrome authenticated successfully. True headless mode is not offered as a working preference in this release. No hidden fallback changes a requested windowless mode into a visible browser.
