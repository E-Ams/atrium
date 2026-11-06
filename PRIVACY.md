# Privacy policy

Last updated: 6 November 2026

Atrium is a Chrome extension that replaces the new tab page with one built from your bookmarks. This policy explains what it does with your data.

## What Atrium reads

Atrium reads your Chrome bookmarks to show them as folder cards and to search them. Your bookmarks are only shown on your new tab page and are never sent anywhere.

## What Atrium stores

- **Settings, layout, pinned links and hidden folders** are saved with `chrome.storage.sync`. Chrome keeps them in your own browser and, if you have sync turned on, syncs them through your Google account.
- **A background image**, if you add one, is resized on your device and saved with `chrome.storage.local`. It never leaves your device.
- **The latest weather reading** is cached with `chrome.storage.local`.

Backups you export are saved as a file on your own device.

## What Atrium sends

Atrium only uses the network for the weather, and only if you set a city:

- When you set a city, its name is sent to the [Open-Meteo](https://open-meteo.com/) geocoding API to find its coordinates.
- To show the temperature, the city's latitude and longitude are sent to the Open-Meteo forecast API.

Like any web request, these also reach Open-Meteo with your IP address. Open-Meteo's own [terms](https://open-meteo.com/en/terms) apply to those requests. If you don't set a city, Atrium makes no network requests.

## What Atrium doesn't do

Atrium has no analytics, tracking or ads, and no server of its own. Your data is never sold, shared with anyone else, or used for anything other than showing your new tab page.

## Removing your data

Clear the city in Atrium's settings to stop the weather requests. Uninstalling Atrium removes everything it has stored.

## Contact

Questions about this policy can be raised as an issue at https://github.com/E-Ams/atrium/issues.
