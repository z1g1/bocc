// The LinkedIn event's confirmation dialog (src/components/admin/LinkedInEvent.astro).
// A file, not an inline script: the admin CSP is script-src 'self'.
//
// "Create live event" is a plain submit button. Without this script it posts without
// confirm=live, the server refuses it and shows the dialog open inline. With it, the
// click opens the native <dialog> as a modal instead; the dialog's own form sends
// confirm=live, and its Cancel button (formmethod="dialog") closes it.
for (const button of document.querySelectorAll("[data-linkedin-open]")) {
  const dialog = document.getElementById(button.dataset.linkedinOpen);
  if (!(dialog instanceof HTMLDialogElement) || typeof dialog.showModal !== "function") continue;
  button.addEventListener("click", (e) => {
    e.preventDefault();
    if (!dialog.open) dialog.showModal();
  });
}
