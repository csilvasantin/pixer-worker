import {WorkerEntrypoint} from 'cloudflare:workers';
import {generateAnnouncement} from './announcement-tts.mjs';
export {default} from './index.js';
// No public route. Pages binds this entrypoint, never the full Worker.
export class AnnouncementTts extends WorkerEntrypoint {
  async generate(input) { return generateAnnouncement(this.env,input); }
}
