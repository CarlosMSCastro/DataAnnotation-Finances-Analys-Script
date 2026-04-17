# DataAnnotation Analytics Dashboard

A Tampermonkey userscript that injects an analytics button into the DataAnnotation payments page, giving you financial stats the platform doesn't show.

## Features

Click the 📊 Analytics button in the navbar to open the dashboard. The script automatically navigates to Funds History, enables "Include paid", and expands all entries before parsing.

The dashboard shows:

**Global totals**
- Total historical earnings
- Paid out to PayPal
- Available to withdraw (Transferrable)
- Pending approval

**Per month (with month selector)**
- Total earnings
- Days worked vs days missed
- Hours logged and hourly rate
- Best earning day
- Projects breakdown with tasks, hours, and hourly rate per project

**Other**
- USD/EUR toggle with live exchange rate
- Collapse button to fold everything back in the page

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Click **Create new script**
3. Delete the default content and paste the contents of `da-analytics.user.js`
4. Save with `Ctrl+S`
5. Go to `https://app.dataannotation.tech/workers/payments`
6. Click **📊 Analytics** in the navbar

The script only runs on the payments page and never interferes with tasks or other areas of the site.


![DA Analytics Dashboard](screenshot.jpg)


## Notes

Projects are grouped by name — Kernel, Achilles, Styx, Thalia, Metis, Andesite, Pegasus, Argon all aggregate automatically. Surveys, qualifications, training tasks, and onboarding are grouped under "DataAnnotation Survey".

The hourly rate only counts logged time entries. Projects like Rate & Review that don't log time will show no hourly rate.
