import { describe, expect, it } from 'vitest';
import { classifyBookingPage } from './_lib.js';
import { __test__ as bookingStatusTest } from './booking-status.js';

describe('classifyBookingPage', () => {
  it('reports confirmation only with a booking reference', () => {
    expect(classifyBookingPage({
      url: 'https://www.district.in/movies/booking-confirmation',
      text: 'Payment successful. Booking ID DBX123456. Your tickets are ready.',
    })).toEqual({
      status: 'confirmed',
      bookingId: 'DBX123456',
      message: 'Payment successful. Booking ID DBX123456. Your tickets are ready.',
    });

    expect(classifyBookingPage({
      url: 'https://www.district.in/movies/booking-confirmation',
      text: 'Payment successful. Booking confirmed.',
    })).toEqual({
      status: 'pending',
      bookingId: '',
      message: 'Payment successful. Booking confirmed.',
    });
  });

  it.each([
    ['Payment failed. Please try again.', 'failed'],
    ['Your booking session has expired.', 'expired'],
    ['Review your booking Pay now ₹640', 'pending'],
  ])('maps %s to %s', (text, status) => {
    expect(classifyBookingPage({
      url: 'https://www.district.in/movies/order-review/example',
      text,
    }).status).toBe(status);
  });

  it('does not mistake ordinary confirmation text for a booking reference', () => {
    expect(classifyBookingPage({
      url: 'https://www.district.in/movies/booking-confirmation',
      text: 'Booking confirmed',
    }).bookingId).toBe('');
  });

  it.each([
    ['wrong host', 'https://district.in.evil.example/movies/booking-confirmation'],
    ['lookalike host', 'https://evildistrict.in/movies/booking-confirmation'],
    ['malformed URL', 'not a URL'],
    ['non-HTTPS District URL', 'http://www.district.in/movies/booking-confirmation'],
  ])('keeps every terminal result pending on a %s', (_label, url) => {
    for (const text of [
      'Payment successful. Booking ID DBX123456. Your tickets are ready.',
      'Payment failed. Please try again.',
      'Your booking session has expired.',
    ]) {
      expect(classifyBookingPage({ url, text })).toMatchObject({
        status: 'pending',
        bookingId: '',
      });
    }
  });

  it.each([
    'https://district.in/movies/booking-confirmation',
    'https://checkout.district.in/movies/booking-confirmation',
  ])('accepts the District apex or a real subdomain: %s', (url) => {
    expect(classifyBookingPage({
      url,
      text: 'Payment successful. Booking ID DBX123456. Your tickets are ready.',
    })).toMatchObject({ status: 'confirmed', bookingId: 'DBX123456' });
  });

  it('extracts booking evidence from full text before truncating the returned message', () => {
    const prefix = 'Still processing. '.repeat(20);
    const result = classifyBookingPage({
      url: 'https://www.district.in/movies/booking-confirmation',
      text: `${prefix} Payment successful. Booking ID DBX123456. Your tickets are ready.`,
    });

    expect(result).toMatchObject({ status: 'confirmed', bookingId: 'DBX123456' });
    expect(result.message).toHaveLength(240);
    expect(result.message).not.toContain('DBX123456');
  });

  it('reads the current persistent District page without navigating', async () => {
    const page = {
      evaluate: async () => ({
        ok: true,
        text: 'Payment successful. Booking ID DBX123456.',
        pageUrl: 'https://www.district.in/movies/booking-confirmation',
        message: 'Payment successful. Booking ID DBX123456.',
      }),
    };

    await expect(bookingStatusTest.readBookingStatus(page, 5)).resolves.toEqual({
      status: 'confirmed',
      bookingId: 'DBX123456',
      message: 'Payment successful. Booking ID DBX123456.',
      pageUrl: 'https://www.district.in/movies/booking-confirmation',
    });
  });
});
