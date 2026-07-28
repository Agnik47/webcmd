---
name: movie-ticket-booking
description: Use when a user wants to find District movies or screenings, choose seats, start checkout, pay, or verify a booking.
version: 1.0.0
author: WebCMD
license: MIT
metadata:
  hermes:
    tags: [district, movies, booking]
---

# District Movie Ticket Booking

## Rules

- Use only `npm --prefix "$MOVIE_DEMO_ROOT" run moviectl -- ...`; this is a
  District-only workflow.
- Never request, expose, or store credentials, OTPs, cookies, card details, or
  payment data. The user completes login and payment on District.
- Show recommendations, then the chosen screening and exact seats.
- Never infer success. A user's "I've paid" claim is not proof of payment.
- Run checkout once per explicit confirmation. Never blindly retry it.

## Workflow

1. Run `npm --prefix "$MOVIE_DEMO_ROOT" run moviectl -- profile get`.
   Continue when saved preferences are known.
2. Ask only for missing movie, city, date, ticket count, or relevant
   preferences such as language, format, time, seat position, and budget.
   Continue when movie, city, date, and count are explicit.
3. Run
   `npm --prefix "$MOVIE_DEMO_ROOT" run moviectl -- district search "$MOVIE" --tab movies --limit 5`,
   then
   `npm --prefix "$MOVIE_DEMO_ROOT" run moviectl -- district showtimes "$MOVIE_URL" --city "$CITY" --date "$DATE" --limit 10`.
   Add only implemented showtime filters when needed: `--after`, `--before`,
   `--cinema`, `--language`, `--max-price`, or `--quality`. Recommend a short
   list containing movie, date, time, cinema, format, price, and show URL.
4. After the user chooses a screening, run
   `npm --prefix "$MOVIE_DEMO_ROOT" run moviectl -- district seats "$SHOW_URL" --count "$COUNT" --together true`.
   Repeat with a relevant `--class` or `--max-price` only to obtain alternatives.
   Present two or three exact seat sets; present fewer when District returns
   fewer.
5. After the user chooses an exact set, run:

   ```bash
   npm --prefix "$MOVIE_DEMO_ROOT" run moviectl -- district prepare-checkout "$SHOW_URL" --movie "$MOVIE" --cinema "$CINEMA" --show-time "$SHOW_TIME" --format-id "$FORMAT_ID" --content-id "$CONTENT_ID" --seats "$SEATS" --amount-paise "$AMOUNT_PAISE"
   ```

   Take `FORMAT_ID` from the showtime row and `CONTENT_ID` from the chosen show
   URL's `contentid` query value. Display the returned attempt's exact movie,
   cinema, show time, seats, and amount. Ask for an explicit yes and wait.
6. Only after explicit yes, run exactly once for that confirmation:
   `npm --prefix "$MOVIE_DEMO_ROOT" run moviectl -- district checkout "$ATTEMPT_ID"`.
   Return the resulting District payment link. If checkout returns an error, do
   not invoke it again until the recovery table explicitly requires a fresh
   summary and a new explicit yes.
7. After the user says "I've paid", always run
   `npm --prefix "$MOVIE_DEMO_ROOT" run moviectl -- district booking-status "$ATTEMPT_ID"`.
   Report confirmed only when District returns `confirmed` and a non-empty
   booking reference; include that reference.

## Error Recovery

| Result | Action |
|---|---|
| `AUTH_REQUIRED` before payment | The attempt returns to `awaiting_confirmation`. Run `npm --prefix "$MOVIE_DEMO_ROOT" run moviectl -- district login`; ask the user to complete login on District without sharing credentials or OTPs. Then display the attempt's exact summary again, obtain a new explicit yes, and invoke checkout once for that confirmation. |
| `EMPTY_RESULT` or seat-unavailable `COMMAND_EXEC` during checkout | The old attempt is expired. Re-run showtimes and seats, prepare a new attempt for the user's new exact choice, display its exact summary, and obtain a new explicit yes. Never checkout the old attempt. |
| Payment pending | Keep the attempt pending and report that result. Re-run `booking-status` only after the user asks or reports payment; do not start another checkout. |
| Payment failed or expired | Report the result. Start a new showtime/seat choice only if the user wants to try again. |
| Unknown, service, or invalid-provider failure | The attempt remains pending because payment state is ambiguous. State the safe error and run `booking-status`, not checkout. Never infer a result or start another checkout while it is pending. |

## Common Pitfalls

- Do not skip `prepare-checkout`, alter its summary, accept vague confirmation,
  reuse an old confirmation after recovery, or treat a payment claim as
  confirmation.
- Do not reuse stale seats, omit `--count` or `--together`, or report a booking
  reference not returned by District.

## Verification Checklist

- [ ] Recommendation, chosen screening, and exact seats were shown.
- [ ] Prepared movie, cinema, show time, seats, and amount were displayed.
- [ ] A fresh explicit yes preceded each single checkout call.
- [ ] The returned payment link was relayed without collecting payment data.
- [ ] Any payment claim triggered `booking-status`.
- [ ] Confirmation includes District's non-empty booking reference.
