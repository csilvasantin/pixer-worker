import {WorkerEntrypoint} from 'cloudflare:workers';
import {generateAnnouncement} from './announcement-tts.mjs';
import {generateAdvertisingImage} from './advertising-image.mjs';
export {default} from './index.js';
// No public route. Pages binds this entrypoint, never the full Worker.
export class AnnouncementTts extends WorkerEntrypoint {
  async generate(input) { return generateAnnouncement(this.env,input); }
  async generateImage(input) { return generateAdvertisingImage(this.env,input); }
}
