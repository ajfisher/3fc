import { createPlayerClient } from './player-client.js';
import { mountAchievementGallery } from './achievement-gallery.js';
const root = document.getElementById('achievement-gallery');
if (root) mountAchievementGallery(root, createPlayerClient({ baseUrl: document.body.dataset.apiBaseUrl || location.origin }));
