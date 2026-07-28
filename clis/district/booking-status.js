import { cli, Strategy } from '@agentrhq/webcmd/registry';
import {
  classifyBookingPage,
  validateTimeout,
  waitFor,
} from './_lib.js';

async function readBookingStatus(page, timeout) {
  const observed = await waitFor(page, 'district booking status', timeout, `
    (() => {
      const text = document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim() : '';
      return {
        ok: Boolean(text),
        text,
        pageUrl: location.href,
        message: text.slice(0, 240)
      };
    })()
  `);
  return {
    ...classifyBookingPage({ url: observed.pageUrl, text: observed.text }),
    pageUrl: observed.pageUrl,
  };
}

cli({
  site: 'district',
  name: 'booking-status',
  access: 'read',
  description: 'Check the current District movie checkout or confirmation result',
  domain: 'www.district.in',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  siteSession: 'persistent',
  args: [
    {
      name: 'timeout',
      type: 'int',
      default: 5,
      help: 'Seconds to wait for District to show a booking state',
    },
  ],
  columns: ['status', 'bookingId', 'message', 'pageUrl'],
  func: async (page, args) => {
    const timeout = validateTimeout(args.timeout, { def: 5, min: 1, max: 60 });
    return readBookingStatus(page, timeout);
  },
});

export const __test__ = { readBookingStatus };
