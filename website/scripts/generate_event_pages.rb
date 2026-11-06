#!/usr/bin/env ruby
# frozen_string_literal: true

# Writes one page per upcoming Tuesday to website/_events/ (gitignored). Runs
# before `jekyll build` because the github-pages gem forces safe mode, which
# blocks Jekyll generator plugins.
#
# Pages cover the next WEEKS Tuesdays as of the build, so the site needs a deploy
# at least once a quarter. Expired URLs redirect to the home page (netlify.toml).
#
# BOCC_TODAY=YYYY-MM-DD overrides the current date for testing.

require 'date'
require 'fileutils'
require 'yaml'

ENV['TZ'] = 'America/New_York'

WEEKS = 13
OUTPUT_DIR = File.expand_path('../_events', __dir__)

# The Tuesdays in the Christmas and New Year's weeks always fall in this window.
def holiday_break?(date)
  (date.month == 12 && date.day >= 20) || (date.month == 1 && date.day <= 2)
end

def upcoming_tuesdays(today)
  first = today + ((2 - today.wday) % 7)
  (0..).lazy.map { |week| first + (week * 7) }.reject { |date| holiday_break?(date) }.first(WEEKS)
end

def iso8601(date, hour, minute)
  Time.new(date.year, date.month, date.day, hour, minute, 0).strftime('%Y-%m-%dT%H:%M:%S%:z')
end

def front_matter(date)
  long_date = date.strftime('%A, %B %-d, %Y')
  {
    'layout' => 'event',
    'title' => long_date,
    'event_name' => "Buffalo Open Coffee Club: #{long_date}",
    'heading' => "Buffalo Open Coffee Club on #{date.strftime('%B %-d')}",
    'description' => "Free networking for Buffalo's entrepreneurs, small business owners, " \
                     "and startup founders on #{long_date}, 7:30-9:00 AM at Seneca One Tower.",
    'long_date' => long_date,
    'start_date' => iso8601(date, 7, 30),
    'end_date' => iso8601(date, 9, 0)
  }
end

today = ENV['BOCC_TODAY'] ? Date.iso8601(ENV['BOCC_TODAY']) : Date.today
FileUtils.rm_rf(OUTPUT_DIR)
FileUtils.mkdir_p(OUTPUT_DIR)

dates = upcoming_tuesdays(today)
dates.each do |date|
  File.write(File.join(OUTPUT_DIR, "#{date.iso8601}.md"), "#{front_matter(date).to_yaml}---\n")
end
puts "Generated #{dates.size} event pages, #{dates.first} through #{dates.last}"
