import { createPlayerClient } from './player-client.js';
import { mountPlayerProfile } from './player-profile.js';
const root = document.getElementById('player-profile');
if (root) mountPlayerProfile(root, createPlayerClient({ baseUrl: document.body.dataset.apiBaseUrl || location.origin }));
