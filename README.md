# Atrium

A Chrome extension that replaces the new tab page with one built from your bookmarks.

## Features

- **Folder cards** – each bookmark folder becomes a card you can collapse, colour and give a Material icon.
- **Search** – search across your bookmarks, and move through the results with the arrow keys.
- **Pinned links** – keep the sites you use most within one click.
- **Weather** – the current temperature and a weather icon for a city you choose, from [Open-Meteo](https://open-meteo.com/) (no API key needed).
- **Light and dark** – follows the system theme or a fixed one, each with its own background colour.
- **Settings** – columns, greeting name, backgrounds, hidden folders, weather city, and backup and restore.

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
| `api.open-meteo.com`, `geocoding-api.open-meteo.com` | Looks up your city and its current weather. |

Atrium sends nothing else anywhere and has no analytics.

## Built with

Plain HTML, CSS and JavaScript on Manifest V3. No build step and no dependencies.
