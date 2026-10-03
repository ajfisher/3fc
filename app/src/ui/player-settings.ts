import { bindPlayerAccount, PlayerClientError, type PlayerClient, type PlayerContext, type OwnerDetails } from './player-client.js';
import { blobDataUrl, decodePortraitSource, drawPortraitCrop, encodePortraitCrop, PortraitCropError, type PortraitSource } from './portrait-crop.js';

type Client = Pick<PlayerClient, 'logout' | 'session' | 'owner' | 'rename' | 'uploadPortrait' | 'removePortrait' | 'portrait'>;
type Crop = Awaited<ReturnType<typeof encodePortraitCrop>>;
type Attempt = { kind: 'name'; playerId: string; displayName: string; expectedRevision: string; idempotencyKey: string }
  | { kind: 'photo'; playerId: string; base64: string; contentType: 'image/png'; expectedRevision: string; idempotencyKey: string }
  | { kind: 'remove'; playerId: string; expectedRevision: string; idempotencyKey: string };
export interface PlayerSettingsOptions {
  root: HTMLElement; client: Client; playerId: string; context?: PlayerContext;
  onSaved?: (details: OwnerDetails) => void;
  media?: { decode?: typeof decodePortraitSource; draw?: typeof drawPortraitCrop; encode?: typeof encodePortraitCrop; dataUrl?: typeof blobDataUrl };
}
/** Private account data and pending photos live only in this page's memory. */
export function initializePlayerSettings(options: PlayerSettingsOptions) {
  const { root, client } = options, document = root.ownerDocument, window = document.defaultView!;
  const get = <T extends HTMLElement>(id: string): T => {
    const node = root.querySelector<T>(`#${id}`); if (!node) throw new Error(`Missing settings control: ${id}`); return node;
  };
  const form = get<HTMLElement>('owner-form'), nameForm = get<HTMLFormElement>('owner-name-form');
  const name = get<HTMLInputElement>('owner-name'), email = get<HTMLInputElement>('owner-email');
  const status = get<HTMLElement>('owner-status'), saveName = get<HTMLButtonElement>('owner-save-name');
  const file = get<HTMLInputElement>('owner-photo-file'), preview = get<HTMLImageElement>('owner-photo-preview');
  const savePhoto = get<HTMLButtonElement>('owner-photo-save'), remove = get<HTMLButtonElement>('owner-photo-remove');
  const retry = get<HTMLButtonElement>('owner-retry'), refresh = get<HTMLButtonElement>('owner-refresh');
  const dialog = get<HTMLDialogElement>('portrait-crop-dialog'), canvas = get<HTMLCanvasElement>('portrait-crop-canvas');
  const zoom = get<HTMLInputElement>('portrait-crop-zoom'), x = get<HTMLInputElement>('portrait-crop-x'), y = get<HTMLInputElement>('portrait-crop-y');
  const confirm = get<HTMLButtonElement>('portrait-crop-confirm'), cancel = get<HTMLButtonElement>('portrait-crop-cancel');
  const cropStatus = get<HTMLElement>('portrait-crop-status');
  const decode = options.media?.decode ?? decodePortraitSource, draw = options.media?.draw ?? drawPortraitCrop;
  const encode = options.media?.encode ?? encodePortraitCrop, dataUrl = options.media?.dataUrl ?? blobDataUrl;
  const controller = new AbortController();
  let generation = 0, cropGeneration = 0, disposed = false, busy = false, blocked = false, conflict = false, preparing = false, accountUnconfirmed = false, checkingAccount = false;
  let identity: OwnerDetails | null = null, account: string | null = null, attempt: Attempt | null = null;
  let source: PortraitSource | null = null, crop: Crop | null = null, currentPhoto: string | null = null, cropTrigger: HTMLElement | null = null;
  const listeners: Array<() => void> = [];
  const listen = (target: EventTarget, event: string, handler: EventListener) => {
    target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler));
  };
  const say = (message: string) => { status.textContent = message; };
  const active = (token: number) => !disposed && token === generation;
  function showPhoto() {
    const value = crop?.previewDataUrl ?? currentPhoto;
    if (value) { preview.src = value; preview.hidden = false; preview.alt = crop ? 'Selected player portrait, not yet saved' : 'Current player portrait'; }
    else { preview.removeAttribute('src'); preview.hidden = true; }
  }
  function controls() {
    const locked = busy || preparing || accountUnconfirmed || blocked || conflict || Boolean(attempt) || !identity;
    form.hidden = !identity || blocked || accountUnconfirmed; dialog.hidden = accountUnconfirmed;
    name.disabled = locked; email.readOnly = true; file.disabled = locked;
    saveName.disabled = locked; savePhoto.disabled = locked || !crop; remove.disabled = locked || !identity?.hasPortrait; remove.hidden = !identity?.hasPortrait;
    retry.hidden = blocked || busy || conflict || !accountUnconfirmed && !attempt && Boolean(identity); retry.disabled = busy;
    refresh.hidden = !conflict || blocked; refresh.disabled = busy;
    form.setAttribute('aria-busy', String(busy));
  }
  function closeCrop() {
    cropGeneration += 1; preparing = false; source?.dispose(); source = null;
    if (dialog.open) dialog.close();
    file.value = ''; confirm.disabled = false; cancel.disabled = false;
    controls();
    if (cropTrigger?.isConnected && !cropTrigger.matches(':disabled')) cropTrigger.focus(); cropTrigger = null;
  }
  function clearPrivate(message: string) {
    generation += 1; busy = false; blocked = true; attempt = null; identity = null; accountUnconfirmed = false;
    accountUi.setAuthenticated(false); if (signin) signin.hidden = false;
    name.value = ''; email.value = ''; crop = null; currentPhoto = null; closeCrop(); showPhoto(); controls(); say(message);
  }
  const accountUi = bindPlayerAccount(document, client, () => clearPrivate('Signing out…'));
  const signin = root.querySelector<HTMLAnchorElement>('#owner-signin');
  if (signin) signin.href = `/sign-in?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  async function verifyAccount() {
    const result = await client.session(controller.signal);
    if (!result.authenticated || !result.session) { clearPrivate('Sign in again to edit your player details.'); throw new PlayerClientError(401, 'signed_out', 'Sign in again.'); }
    const value = `${result.session.subject ?? result.session.email}\n${result.session.sessionId}`;
    if (account !== null && value !== account) { clearPrivate('Your signed-in account changed. Reload this page to continue.'); throw new PlayerClientError(401, 'account_changed', 'Account changed.'); }
    account = value; accountUi.setAuthenticated(true); if (signin) signin.hidden = true;
  }
  function denied(error: unknown): boolean {
    if (error instanceof PlayerClientError && [401, 403].includes(error.status)) {
      clearPrivate(error.status === 401 ? 'Sign in again to edit your player details.' : 'Only the linked player can edit these details.'); return true;
    }
    return false;
  }
  async function load(preserveDraft = false, afterSave = false) {
    if (disposed || busy || blocked) return;
    const token = ++generation, draft = name.value; busy = true; accountUnconfirmed = true; controls(); say('Loading your player details…');
    try {
      await verifyAccount(); if (!active(token)) return;
      const details = await client.owner(options.playerId, controller.signal);
      await verifyAccount(); if (!active(token)) return;
      identity = { playerId: details.playerId, displayName: details.displayName, hasPortrait: details.hasPortrait, revision: details.revision };
      name.value = preserveDraft ? draft : details.displayName; email.value = details.email;
      currentPhoto = null;
      let photoUnavailable = false;
      if (details.hasPortrait && options.context) {
        try {
          const blob = await client.portrait({ ...options.context, playerId: details.playerId }, controller.signal);
          const url = blob ? await dataUrl(blob) : null;
          if (!active(token)) return;
          currentPhoto = url; photoUnavailable = !blob;
        } catch { if (!active(token)) return; photoUnavailable = true; }
      }
      await verifyAccount(); if (!active(token)) return;
      accountUnconfirmed = false; conflict = false; attempt = null; showPhoto();
      say(photoUnavailable ? 'Your details are ready. The current photo could not be loaded.' : afterSave ? 'Save confirmed. Your latest player details are shown.' : preserveDraft ? 'Details refreshed. Your draft is kept. Review it, then save.' : 'Your account details are visible only to you.');
    } catch (error) {
      if (!active(token) || denied(error)) return;
      say(afterSave ? 'Save confirmed, but current details could not be refreshed. Refresh before editing again.' : 'Your details could not be loaded. Try again.');
    } finally { if (active(token)) { busy = false; controls(); } }
  }
  async function submitAttempt() {
    if (!attempt || busy || blocked || disposed) return;
    const pending = attempt, token = generation; busy = true; controls(); say('Saving your player details…');
    try {
      await verifyAccount(); if (!active(token)) return;
      const { playerId, kind, ...body } = pending;
      const saved = kind === 'name' ? await client.rename(playerId, body as Extract<Attempt, { kind: 'name' }>, controller.signal)
        : kind === 'photo' ? await client.uploadPortrait(playerId, body as Extract<Attempt, { kind: 'photo' }>, controller.signal)
          : await client.removePortrait(playerId, body, controller.signal);
      await verifyAccount(); if (!active(token)) return;
      // A replay receipt proves completion, not the current presentation. Read
      // current owner state before enabling another write or displaying a photo.
      attempt = null; conflict = true;
      if (kind === 'name') name.value = saved.displayName;
      else { crop = null; currentPhoto = null; showPhoto(); }
      busy = false; await load(kind !== 'name', true);
      if (!disposed && !blocked && !conflict && identity) options.onSaved?.(identity);
    } catch (error) {
      if (!active(token) || denied(error)) return;
      if (error instanceof PlayerClientError && error.status === 409) {
        attempt = null; conflict = true; say('Your details changed before this save. Refresh the details, review your draft, then save again.');
      } else if (error instanceof PlayerClientError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        attempt = null; say(error.status === 400 ? 'Check your name or selected photo, then try again.' : 'Editing is temporarily unavailable. Your draft is kept.');
      } else say('We could not confirm the save. Retry this exact save before making another change.');
    } finally { if (active(token)) { busy = false; controls(); } }
  }
  function begin(kind: Attempt['kind']) {
    if (busy || preparing || accountUnconfirmed || blocked || conflict || attempt || !identity || disposed) return;
    const common = { playerId: identity.playerId, expectedRevision: identity.revision, idempotencyKey: window.crypto.randomUUID() };
    if (kind === 'name') {
      const value = name.value.trim();
      try { encodeURIComponent(value); } catch { say('Enter a valid display name.'); return; }
      if (!value || value.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) { say('Enter a display name from 1 to 80 characters.'); return; }
      if (value === identity.displayName) { say('Your display name is already saved.'); return; }
      attempt = { ...common, kind, displayName: value };
    } else if (kind === 'photo') { if (!crop) return; attempt = { ...common, kind, base64: crop.base64, contentType: 'image/png' }; }
    else { if (!identity.hasPortrait) return; attempt = { ...common, kind }; }
    void submitAttempt();
  }
  function drawCrop() {
    if (!source) return;
    try { draw(canvas, source, { zoom: Number(zoom.value), panX: Number(x.value), panY: Number(y.value) }); cropStatus.textContent = ''; }
    catch (error) { cropStatus.textContent = error instanceof PortraitCropError ? error.message : 'The crop could not be displayed.'; confirm.disabled = true; }
  }
  async function choosePhoto() {
    if (busy || preparing || accountUnconfirmed || blocked || conflict || attempt || !identity || disposed) return;
    const selected = file.files?.[0]; if (!selected) return;
    const token = ++cropGeneration, ownerToken = generation;
    source?.dispose(); source = null; preparing = true; controls(); say('Preparing your photo…');
    try {
      const value = await decode(selected);
      if (disposed || token !== cropGeneration || ownerToken !== generation) { value.dispose(); return; }
      source = value; zoom.value = '1'; x.value = '0'; y.value = '0'; confirm.disabled = false;
      cropTrigger = file;
      dialog.showModal(); drawCrop(); zoom.focus(); say('Position your photo, then use this crop.');
    } catch (error) {
      if (disposed || token !== cropGeneration || ownerToken !== generation) return;
      source?.dispose(); source = null; preparing = false; file.value = '';
      say(error instanceof PortraitCropError ? error.message : 'This photo could not be opened. Choose another photo.');
    } finally { if (!disposed && token === cropGeneration) controls(); }
  }
  async function acceptCrop() {
    if (!source || confirm.disabled || disposed) return;
    const token = cropGeneration; confirm.disabled = true; cancel.disabled = true;
    cropStatus.textContent = 'Preparing the crop…';
    try {
      const value = await encode(canvas);
      if (disposed || token !== cropGeneration) return;
      crop = value; closeCrop(); showPhoto(); say('Your crop is ready. Save photo to make it visible to league viewers.'); controls();
    } catch (error) {
      if (disposed || token !== cropGeneration) return;
      cropStatus.textContent = error instanceof PortraitCropError ? error.message : 'The crop could not be prepared. Try again.';
      confirm.disabled = false; cancel.disabled = false;
    }
  }
  listen(nameForm, 'submit', event => { event.preventDefault(); begin('name'); });
  listen(savePhoto, 'click', () => begin('photo')); listen(remove, 'click', () => begin('remove'));
  listen(retry, 'click', () => { if (!identity) void load(); else if (accountUnconfirmed) void recheckAccount(); else if (attempt) void submitAttempt(); else void load(); });
  listen(refresh, 'click', () => { if (conflict) void load(true); });
  listen(file, 'change', () => { void choosePhoto(); });
  for (const input of [zoom, x, y]) listen(input, 'input', () => drawCrop());
  listen(confirm, 'click', () => { void acceptCrop(); });
  listen(cancel, 'click', () => { closeCrop(); controls(); });
  listen(dialog, 'cancel', event => { event.preventDefault(); closeCrop(); controls(); });
  listen(dialog, 'keydown', event => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href]')];
    const first = controls[0], last = controls.at(-1);
    if (keyboard.shiftKey && document.activeElement === first) { keyboard.preventDefault(); last?.focus(); }
    else if (!keyboard.shiftKey && document.activeElement === last) { keyboard.preventDefault(); first?.focus(); }
  });
  async function recheckAccount() {
    if (!account || disposed || blocked || checkingAccount) return;
    checkingAccount = true; accountUnconfirmed = true;
    const message = status.textContent ?? ''; controls(); say('Checking your account…');
    try { await verifyAccount(); if (!disposed && !blocked) { accountUnconfirmed = false; say(message); } }
    catch (error) { if (!disposed && !denied(error)) { closeCrop(); say('Your account could not be verified. Retry before continuing.'); } }
    finally { checkingAccount = false; if (!disposed) controls(); }
  }
  listen(window, 'focus', () => { void recheckAccount(); });
  for (const event of ['threefc:player-proof-cleared', 'threefc:player-proof-invalidated'])
    listen(window, event, () => clearPrivate('Your account access changed. Sign in again to continue.'));
  const dispose = () => {
    if (disposed) return; clearPrivate(''); disposed = true; controller.abort();
    for (const removeListener of listeners) removeListener(); accountUi.destroy();
  };
  listen(window, 'pagehide', dispose);
  controls(); const ready = load();
  return { ready, dispose };
}

/** BFCache restores must start with a fresh owner/session read, never a private snapshot. */
export function initializeRestoringPlayerSettings(options: PlayerSettingsOptions) {
  let current = initializePlayerSettings(options);
  const window = options.root.ownerDocument.defaultView!;
  const restore = (event: PageTransitionEvent) => {
    if (event.persisted) { current.dispose(); current = initializePlayerSettings(options); }
  };
  window.addEventListener('pageshow', restore);
  return { get ready() { return current.ready; }, dispose() { window.removeEventListener('pageshow', restore); current.dispose(); } };
}
