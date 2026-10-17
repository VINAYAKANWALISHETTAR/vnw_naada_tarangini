# 🎵 Naada Tarangini (ನಾದ ತರಂಗಿಣಿ)

> A clean, lightweight, ad-free YouTube Music desktop player and widget.  
> Developed by **[Vinayaka N Walshettar](https://www.nayaka100.in/)**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](https://github.com)

Naada Tarangini is a desktop music player that lets you search YouTube Music, stream ad-free audio directly, and manage your playback without intrusive browser tabs or ads. It runs as a standalone desktop player with background stream caching, offline support, favourites, and mini-player controls.

---

## 🌟 Join & Contribute — Build Together!

> **🤝 A Note on Community & Respect:**  
> Please **do not just copy or rebrand this project as your own**. Instead, **star ⭐ this repository, become a contributor, and let's improve it together!**
> 
> Whether you want to fix a bug, enhance the UI, or add new music features, your contributions are warmly welcomed.
> 
> - **Star the repo** to show your support!
> - **Submit Pull Requests (PRs)**: I actively review, provide feedback, and merge community PRs.
> - **Open Issues**: Found a bug or have a feature idea? Share it in the GitHub Issues tab.

### How to Submit a Pull Request (PR):
1. **Fork** this repository.
2. Create a new feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Commit your changes:
   ```bash
   git commit -m "Add awesome new feature"
   ```
4. Push to your branch:
   ```bash
   git push origin feature/your-feature-name
   ```
5. Open a **Pull Request** on GitHub with a description of what you improved.

---

## ✨ Features

- **🔍 Direct YouTube Music Search**: Search any song, artist, album, or paste YouTube links directly.
- **🎧 Ad-Free Audio Streaming**: Directly streams audio via `yt-dlp` without loading heavy web pages, ads, or video canvases.
- **⚡ Fast Stream Caching**: Signed stream URLs are automatically cached on disk, making replayed tracks start almost instantly.
- **❤️ Favourites & History**: Click the heart button to save your favorite songs permanently, and browse your recent playback history in the Library panel.
- **📚 Library Panel**: Manage your Queue, Favourites, and History in one tabbed view. Reorder, play next, or remove tracks easily.
- **🔀 Shuffle & Repeat**: Full repeat (off / all / one) and shuffle modes that remember your original playlist order.
- **🖼 Always-Loaded Artwork**: Ships with bundled offline covers for default Kannada songs so artwork loads instantly even on slow connections.
- **🪟 Flexible Desktop Controls**: Minimalist, frameless design with minimize-to-bar, system tray integration, and desktop shortcut generation.

---

## 🚀 Download & Installation

### Option 1: Download the Ready-to-Use Windows App (Recommended)
You don't need to install Node.js, Python, or anything else:
1. Go to the **[Releases](https://github.com)** tab on this repository.
2. Download the latest **`naada_tarangini-setup-1.1.0.exe`**.
3. Run the installer — the player installs and launches with all dependencies bundled!

---

### Option 2: Run from Source (For Developers)

#### Prerequisites:
- [Node.js](https://nodejs.org) (v18.17 or higher)

#### Setup Steps:
1. **Clone the repository**:
   ```bash
   git clone https://github.com/<your-username>/naada_tarangini.git
   cd naada_tarangini
   ```

2. **Run setup**:
   Double-click **`setup.bat`** (or run `npm install`).  
   *This automatically installs dependencies and downloads the `yt-dlp` stream helper into `vendor/`.*

3. **Launch the player**:
   Double-click **`run.bat`** (or run `npm start`).

---

## 🎹 Keyboard Shortcuts & Controls

| Action | Shortcut / Control |
| :--- | :--- |
| **Play / Pause** | `Space` or Play/Pause button |
| **Next / Previous Track** | `←` / `→` arrow keys or Next/Prev buttons |
| **Volume / Mute** | Volume slider or speaker button |
| **Search** | Type in search bar, press `Enter` |
| **Queue & Favourites** | Click the ☰ Library button (or press `Esc` to close) |
| **Repeat Mode** | 🔁 Cycles: Off → All → One |
| **Shuffle Mode** | 🔀 Toggles random queue playback |
| **Desktop Shortcut** | Click 🖥 in title bar to create/remove desktop shortcut |

---

## 📦 Building the Installer

To compile and package the standalone `.exe` installer yourself:

```bash
npm run dist
```

The compiled installer will be generated in the **`dist/`** directory:  
`dist/naada_tarangini-setup-1.1.0.exe`

---

## 🛠 Tech Stack

- **Desktop Shell**: Electron (Frameless, Custom Titlebar, System Tray)
- **Frontend**: HTML5, Modern CSS, Swiper.js, Font Awesome
- **Audio & Data**: YouTube InnerTube API (ad-free data layer) + `yt-dlp`
- **Packaging**: `electron-builder` (NSIS Windows Installer)

---

## 🔒 Privacy & Safety

- **No login or account needed**: Never asks for credentials or cookies.
- **Local storage only**: Your favourites, history, and volume settings are stored only on your local machine (`localStorage`). No tracking or personal data collection.

---

## 👨‍💻 Author & Maintainer

Developed by **[Vinayaka N Walshettar]**  
🌐 **Website & Portfolio**: [https://www.nayaka100.in/] 
💼 **LinkedIn**: [https://www.linkedin.com/in/vinayaka-n-walishettar/]

---

## 📜 License

Distributed under the **MIT License**. See `LICENSE` for more information.  
Remember to give credit, star the project, and contribute back! ⭐
