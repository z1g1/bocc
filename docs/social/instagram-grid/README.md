# Instagram 3x3 profile grid

Nine 1080x1080 tiles that assemble into one picture on the
@716coffeeclub profile. Content is lifted from the home page
(`website/_data/home.yml`): hero title and lead, the schedule heading,
the stat strip, the Lena Levine pull quote, and the sign-up close.
Colors and fonts match `website/_site/assets/css/main.css`.

## Posting order

Instagram fills the grid newest-first, top-left. Post the tiles in
filename order, `post-01` first and `post-09` last, and the composite
appears top-left to bottom-right once all nine are up. Post all nine
in one sitting so the grid is never half-built for long.

| File | Grid position | Content |
|------|---------------|---------|
| post-01-row3-col3 | bottom right | See you Tuesday, 716coffee.club |
| post-02-row3-col2 | bottom middle | Polaroid photo, Gives and Asks |
| post-03-row3-col1 | bottom left | Stat strip |
| post-04-row2-col3 | middle right | Quote, Lena Levine |
| post-05-row2-col2 | centre | Logo, No badges. No pitches. Just coffee. |
| post-06-row2-col1 | middle left | Photo, Seneca One lobby |
| post-07-row1-col3 | top right | Tuesdays 7:30-9 AM |
| post-08-row1-col2 | top middle | Photo, every Tuesday morning |
| post-09-row1-col1 | top left | Your first free entrepreneurial step in Buffalo |

## Regenerating

`grid.html` is the source. `render.js` screenshots it at 3240x3240 with
Playwright; slice into tiles with any image tool (crop on a 1080 step).
Fonts in `src/` are the self-hosted Fontsource builds of the site's
Google Fonts (Bricolage Grotesque, Hanken Grotesk, Spline Sans Mono).
Photos in `src/` are the about-page photos cropped to the top-left 84%
to drop the baked-in badge.
