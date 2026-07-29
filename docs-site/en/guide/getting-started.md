# Quick Start

There are two ways to use PiDeck: download a pre-built installer or run from source.

## Download & Install

1. Go to the [GitHub Releases](https://github.com/ayuayue/PiDeck/releases) page.
2. Download the latest installer for your platform:
   - **Windows**: `.exe` installer or `.zip` portable
   - **macOS**: `.dmg` (Apple Silicon / Intel)
   - **Linux**: `.AppImage` or `.deb`
3. Run the installer and follow the setup wizard.
4. Launch PiDeck — you'll see the project workspace and session panel.

## Run from Source

### Prerequisites

- **Node.js** >= 20
- **npm** >= 9
- **Git**

### Steps

```bash
# Clone the repository
git clone https://github.com/ayuayue/PiDeck.git
cd PiDeck

# Install dependencies
npm install

# Start in development mode
npm run dev
```

This launches the Electron app with hot-reload enabled.

### Build for Distribution

```bash
# Package for your current platform
npm run dist
```

Output files are placed in the `release/` directory.

## Start a Project

1. Click **"Add Project"** or drag a folder into the workspace panel.
2. Select a project to open its session view.
3. Type your prompt in the composer and press Enter — PiDeck will start a pi RPC agent for that project.
