// Media rules: pure, no imports, so other pure rules (social-plan-rules.mjs) can share them
// without loading the database side, src/lib/admin/media.mjs.

/** A Photo from Event's event_media kind (GLOSSARY.md): cleared by the photo waiver, always publicly usable. */
export const EVENT_PHOTO_KIND = "event_photo";
