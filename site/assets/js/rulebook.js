// Address the reader only by their seat number (?seat=SZV-073). Anything else is ignored.
const seat = (new URLSearchParams(location.search).get("seat") ?? "").toUpperCase();
if (/^(SZV-\d{3}|NRV-\d{2})$/.test(seat)) document.querySelectorAll("[data-seat]").forEach((el) => (el.textContent = seat));
