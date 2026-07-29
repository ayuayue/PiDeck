# Development & Packaging

This guide covers building PiDeck from source and creating distribution packages.

## Development Setup

```bash
# Clone
git clone https://github.com/ayuayue/PiDeck.git
cd PiDeck

# Install
npm install

# Start dev mode
npm run dev
```

The dev mode launches the Electron app with Vite hot-reload. Changes to the renderer, main, or preload processes are reflected immediately.

## Project Structure

```
src/
├── main/              # Electron main process
│   ├── pi/            # pi RPC process management
│   ├── sessions/      # Session scanning & import
│   ├── git/           # Git service
│   ├── settings/      # Settings store
│   └── ...
├── preload/           # Preload scripts (IPC bridge)
├── renderer/
│   └── src/
│       ├── components/  # React UI components
│       ├── config/      # Settings panel tabs
│       ├── utils/       # Utilities
│       └── styles.css   # Global styles
└── shared/            # Shared IPC channel definitions
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development mode |
| `npm run build` | Type-check and build |
| `npm run dist` | Build and package for current platform |
| `npm run dist:win` | Package for Windows |
| `npm run dist:mac` | Package for macOS |
| `npm run dist:linux` | Package for Linux |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run docs:dev` | Start docs site dev server |

## Packaging

PiDeck uses `electron-builder` for packaging. The build configuration is in `package.json` under the `"build"` key.

### Platform-Specific Notes

**Windows:**
- Requires NSIS for the .exe installer
- Windows 10+ recommended
- Code signing optional but recommended for distribution

**macOS:**
- Requires a Mac for building .dmg packages
- Apple Silicon (arm64) and Intel (x64) builds supported
- Notarization recommended for distribution

**Linux:**
- AppImage and deb targets supported
- FUSE required for AppImage
- Tested on Ubuntu 22.04+

### Output

Packaged files are written to the `release/` directory. The output includes:

- Installer (`.exe`, `.dmg`, `.AppImage`, or `.deb`)
- Portable version (`.zip`)
- Latest.yml for auto-update

## Contributing

See [CONTRIBUTING.md](https://github.com/ayuayue/PiDeck/blob/main/CONTRIBUTING.md) for contribution guidelines. All contributions are welcome!
