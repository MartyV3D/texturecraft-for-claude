# TextureCraft for Claude

A Claude Desktop extension that lets Claude work in [TextureCraft](https://getartcraft.com/apps/texturecraft), the open-source 3D texture painting app from ArtCraft. Claude can inspect your layer stack, run any TextureCraft command, bake mesh maps, paint, click menus and take screenshots, all in the TextureCraft window you have open.

You don't have to edit any config file. Install the extension with a click.

> This is an unofficial community extension. It isn't made by or affiliated with ArtCraft or Anthropic. It uses the MCP server that ships with TextureCraft (`texturecraft-cli`).

## What you need

- [Claude Desktop](https://claude.ai/download)
- [TextureCraft](https://getartcraft.com/apps/texturecraft), installed with the installer or the ArtCraft Launcher, so that `texturecraft-cli` is installed too

## Install

1. Download `texturecraft-for-claude.mcpb` from the [latest release](../../releases/latest).
2. Double-click it, or drag it into Claude: **Settings › Desktop app › Extensions**.
3. Click **Install**.

## Start TextureCraft with Claude access

Claude can only reach TextureCraft when the app starts with `--control 7878`. A desktop shortcut does that for you.

**Windows**

1. Right-click your desktop, then go to **New › Shortcut**.
2. In **Type the location of the item**, enter:
   ```
   "C:\Program Files\TextureCraft\texturecraft.exe" --control 7878
   ```
   If TextureCraft is somewhere else, open the ArtCraft Launcher, click the **⋯** next to TextureCraft, choose **Show in Explorer**, right-click `texturecraft.exe` and choose **Copy as path**. Paste that, then add ` --control 7878` after it.
3. Click **Next**, name it `TextureCraft (Claude)`, and click **Finish**.

**macOS / Linux**

```sh
texturecraft --control 7878
```

Open TextureCraft with this shortcut whenever you want Claude to work in it. You can open Claude and TextureCraft in either order. If you restart TextureCraft, the extension reconnects by itself.

## Try it

Ask Claude for example:

- *"Take a screenshot of the TextureCraft viewport."*
- *"What layers does my project have?"*
- *"Add a fill layer in dark blue with roughness 0.2, then bake the mesh maps."*

## Settings

You'll find these in Claude under **Settings › Desktop app › Extensions › TextureCraft for Claude**.

| Setting | Default | What it's for |
|---|---|---|
| TextureCraft CLI | found automatically | Only needed if TextureCraft isn't in a standard place: choose `texturecraft-cli.exe` in your TextureCraft folder (choosing `texturecraft.exe` or the folder works too) |
| Control port | 7878 | Must match the number after `--control` in your shortcut |

## Good to know

- **Updates.** When TextureCraft starts with `--control`, it doesn't check for updates at startup. Use **Help › Check for Updates** in TextureCraft, or the ArtCraft Launcher. Your shortcut keeps working after updates, because the installer updates TextureCraft in the same folder.
- **Files.** In this mode Claude works in the app you have open, so you open and save files in TextureCraft yourself. If you ask Claude to save, it uses **File › Save**.
- **Not working?** In TextureCraft, check that you opened it with your shortcut. In Claude, check that the extension is turned on and shows as running.

## How it works

TextureCraft has its own MCP server: `texturecraft-cli mcp --bridge 7878` connects to the running app over a local connection. Every time TextureCraft starts, it creates a new secret token for that connection, and the bridge only reads that token when it starts. So on its own, the bridge stops working when TextureCraft is opened after Claude, or restarted.

This extension adds a small launcher ([`server/index.js`](server/index.js), Node.js built-ins only):

- It finds `texturecraft-cli` in the usual install locations or on your `PATH`.
- Before each request, it checks TextureCraft's token. If TextureCraft has been started or restarted since, the launcher restarts the bridge with the new token and repeats the MCP handshake. Claude doesn't notice.
- If `texturecraft-cli` can't be found, Claude gets a clear explanation instead of a failing server.

The token is passed to the bridge through its environment, never on the command line. Everything stays on your computer.

## Build it yourself

```sh
npm run validate   # check manifest.json
npm run pack       # writes dist/texturecraft-for-claude.mcpb
TEXTURECRAFT_CLI=/path/to/texturecraft-cli npm test   # end-to-end test against a fake TextureCraft
```

## Credits

- [TextureCraft](https://github.com/storytold/texturecraft) by Storyteller / ArtCraft (MIT or Apache-2.0)
- Extension by MartyV3D, [MIT licence](LICENSE)
