'use strict';

// Removes deleted bookmarks from the pinned list, so pins don't pile up in synced storage.
// This runs in the background rather than on the new tab page, so it also catches bookmarks
// deleted while no Atrium tab is open.
//
// It only acts on deletions it sees. Pins that don't match a bookmark here aren't removed,
// because bookmark ids differ between computers and those pins may belong to another one.

function collectIds(node, out = []) {
  out.push(node.id);
  for (const c of node.children || []) collectIds(c, out);
  return out;
}

chrome.bookmarks.onRemoved.addListener(async (id, info) => {
  // Deleting a folder deletes everything in it; info.node lists its contents.
  const gone = new Set(info && info.node ? collectIds(info.node) : [id]);
  const { pinned } = await chrome.storage.sync.get('pinned');
  if (!Array.isArray(pinned)) return;
  const next = pinned.filter((p) => !gone.has(p));
  if (next.length !== pinned.length) await chrome.storage.sync.set({ pinned: next });
});
