// Reading posted form fields (FormData) in the admin pages' handlers. No imports.

/**
 * A text field's value, or "" when it is missing or a file.
 * @param {FormData} form
 * @param {string} name
 * @returns {string}
 */
export function formField(form, name) {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}
