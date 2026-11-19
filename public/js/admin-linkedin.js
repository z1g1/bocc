// The LinkedIn event's confirmation dialog (src/components/admin/LinkedInEvent.astro).
// A file, not an inline script: the admin CSP is script-src 'self'.
//
// "Create live event" and "Publish event" are plain submit buttons. Without this script
// they post without
// confirm=live, the server refuses (409) and shows the dialog open inline. With it, a
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
