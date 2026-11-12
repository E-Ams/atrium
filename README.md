# Atrium

A Chrome extension that replaces the new tab page with one built from your bookmarks.

## Features

- **Folder cards** – each bookmark folder becomes a card you can collapse, colour and give a Material icon. Collapse or expand them all at once, or open every link in a folder as tabs.
- **Search** – search across your bookmarks, and move through the results with the arrow keys. Collapsed cards open while they have matches, and a subfolder shows which link inside it matched.
- **Right-click menu** – open a link in a new tab, window or incognito window, copy it, pin it, edit it or delete it (with undo). Folders can be opened all at once.
- **Pinned links** – keep the sites you use most within one click. Drag them to reorder.
- **Weather** – the current temperature, today's high and low, and a 5-day forecast (click the weather) for a city you choose, from [Open-Meteo](https://open-meteo.com/) (no API key needed).
- **Light and dark** – follows the system theme or a fixed one, each with its own background colour.
- **Settings** – columns, greeting name, backgrounds, hidden folders, a duplicate bookmark finder, weather city, and backup and restore.

Settings and layout are saved with `chrome.storage.sync`, so they follow you to any device signed in to the same Chrome account. A background image stays on the device it was added on.

## Install

Atrium isn't on the Chrome Web Store. To load it yourself:

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the repository folder.
4. Open a new tab.

## Permissions

| Permission | Why |
| --- | --- |
| `bookmarks` | Reads your bookmarks to build the cards. |
| `storage` | Saves your settings and layout. |
| `favicon` | Shows site icons next to links. |

If you set a city for the weather, Atrium sends its name to Open-Meteo to look it up, then its coordinates to get the temperature. It sends nothing else anywhere and has no analytics. See the [privacy policy](PRIVACY.md).

## Built with

Plain HTML, CSS and JavaScript on Manifest V3. No build step and no dependencies.
