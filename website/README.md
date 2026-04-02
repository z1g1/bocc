# BOCC Website

## Ruby Setup
1. Install ``rbenv`` and ``ruby-build`` for an isolated enviroment. ``brew install rbenv ruby-build``
1. Make sure these are in the path 
1. Use the Gemfile to specify what you need for the project 
1. Install Gems to a Local Path ``bundle config set --local path 'vendor/bundle'`` then ``bundle install`` to install all the Gems
1. Run commands vs the local set using ``bundle exec COMMAND.....``


## Local Testing

1. Run ``bundle install`` after doing a git clone to make sure you have dependencies installed 
1. **Only if you need a blank site** Generated the basic site using ``bundle exec jekyll new --skip-bundle . --force`` per [docs](https://docs.github.com/en/pages/setting-up-a-github-pages-site-with-jekyll/creating-a-github-pages-site-with-jekyll)
1. To make sure we can test the site using the Eventbrite [embed checkout](https://www.eventbrite.com/help/en-us/articles/347218/how-to-sell-eventbrite-tickets-on-your-website-through-an-embedded-checkout/) generate a self signed SSL Certificate
  1. The Keys are self-signed so there shouldn't be an issue with them on Github, but just to be safe add ``ssl/*``, ``*.key``, and ``*.cert`` to ``.Gitignore``
  1. Create an SSL directory in the local branch
  1. Generate the self-signed cert. You can generate fake info except for **Common Name (CN)** which must be ``localhost``. ``openssl req -x509 -out localhost.crt -keyout localhost.key -newkey rsa:2048 -nodes -sha256 -subj '/CN=localhost' -extensions EXT -config <( \
   printf "[dn]\nCN=localhost\n[req]\ndistinguished_name = dn\n[EXT]\nsubjectAltName=DNS:localhost\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth") -days 365`` hat tip to [Clayton Errington's blog post](https://claytonerrington.com/blog/securing-jekyll-with-ssl-locally/) that helped me get this working
1. Generate and run the basic site using ``bundle exec jekyll serve --host localhost --ssl-key ssl/localhost.key --ssl-cert ssl/localhost.crt``. Since we're using TLS use this vs the normal ``bundle exec jekyll serve``


## Theme
1. Based the theme off of [minimal-mistakes](https://github.com/mmistakes/minimal-mistakes)
1. Need to install it as a [remote theme](https://mmistakes.github.io/minimal-mistakes/docs/quick-start-guide/)
to be compatible with GitHub Pages. Add ``gem "jekyll-include-cache", group: :jekyll_plugins`` to Gemfile, then added ``jekyll-include-cache`` to ``plugins`` array in ``_config.yml``


## Sponsor Redirect (Post-Check-in)

After a visitor checks in at an event, they see a countdown and are redirected to the current sponsor's website. This fulfills the "Redirect link on BOCC's digital Check-in App" benefit listed on the sponsorship page.

### Configuration

Edit ``_data/sponsor.yml``:

```yaml
enabled: true          # set to false to disable the redirect entirely
name: "Sponsor Name"   # displayed in the countdown message
url: "https://..."     # redirect destination
delay: 5               # seconds before redirect
```

### How it works

- After check-in, the greeting shows: "Visiting **Sponsor Name** in 5 seconds..."
- Users can click "Go now" to redirect immediately, or "Stay here" to cancel
- The sponsor data is injected into check-in pages at build time via Jekyll/Liquid
- Both ``/checkin/bocc`` and ``/checkin/bocc-afternoon`` use the same sponsor config

### To update the sponsor

1. Edit ``_data/sponsor.yml`` with the new sponsor's name and URL
2. Commit and push -- GitHub Pages will rebuild automatically
3. No code changes required
