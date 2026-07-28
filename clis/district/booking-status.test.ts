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
