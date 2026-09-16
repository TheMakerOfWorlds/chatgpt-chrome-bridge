# Install on a Mac

The bridge runs locally on **macOS** (Apple Silicon or Intel) using Google Chrome and Codex. Windows and Linux are not supported by this release. Your ChatGPT account must have access to the effort options you request. It uses the ChatGPT website; an OpenAI API key is not needed.

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
5. Start a **new Codex task** and say: “Use ChatGPT to help me with this.”

The installer downloads the latest stable GitHub release, installs locked dependencies, registers its own Codex marketplace, and enables automatic updates. Your existing profile, project destination, and login settings are preserved on subsequent runs. New users start without a ChatGPT project destination; optionally ask Codex to configure one later.

If the repository is private, only invited GitHub users can download it. Run `gh auth login` with an authorized GitHub account before installation. Public installations do not need a GitHub account. ChatGPT sign-in and GitHub access are separate.

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
- **An old personal install is also enabled**: After its jobs finish, remove `chatgpt-chrome-bridge@personal` with `codex plugin remove chatgpt-chrome-bridge@personal`. Keep the new `chatgpt-bridge-releases` installation enabled. Removing the old plugin does not delete ChatGPT login state.

The bridge maintains small disposable browser caches automatically. Saved output files and protected login state are not deleted by storage cleanup.
