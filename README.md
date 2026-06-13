# 9 Quincy Property Management Agent

Automated property management system for 9 Quincy Pl NE #2, Washington DC.

## What this does

- **Twilio SMS agent** — automatically handles all tenant texts (Temi & Chloe), classifies urgency, gathers information, alerts you when needed
- **Payment tracking** — log and track rent + utility payments per tenant
- **Utility bill splitter** — auto-calculates tenant shares, notifies tenants via SMS
- **Scheduling** — coordinates cleaning (Dazzling), pest control (Mehmet), and Thumbtack pros with tenants automatically
- **Broadcast** — send group or individual messages via agent
- **Dashboard** — web app to review everything, approve responses, manage tenants

## Setup (do this once)

### 1. Environment variables

Copy `.env.example` to `.env` and fill in:

```
TWILIO_ACCOUNT_SID=        # from twilio.com/console
TWILIO_AUTH_TOKEN=          # from twilio.com/console  
TWILIO_PHONE_NUMBER=        # your Twilio number e.g. +12025551234
ANTHROPIC_API_KEY=          # from console.anthropic.com
OWNER_PHONE=+17347075258
OWNER_EMAIL=tonisuh@umich.edu
DASHBOARD_PASSWORD=         # choose a password for your dashboard
PORT=3000
```

### 2. Deploy to Railway

1. Push this folder to a GitHub repo (can be private)
2. Go to railway.app → New Project → Deploy from GitHub
3. Select your repo
4. Go to Variables tab → add all variables from above
5. Railway will give you a URL like `https://your-app.railway.app`

### 3. Set Twilio webhook

1. Go to twilio.com/console → Phone Numbers → your number
2. Under "Messaging" → "A message comes in" → set to:
   `https://your-app.railway.app/webhook/sms`
3. Method: POST

### 4. Tell tenants their new number

Send them a broadcast from the dashboard:
> "Hi [name], we've set up a new property management line. Please use [your Twilio number] for all future questions, maintenance requests, and payment confirmations. — 9 Quincy Management"

### 5. Add to iPhone home screen

Open your Railway URL in Safari → Share → Add to Home Screen → it works like an app.

## How to use

### Tenant texts in
Agent auto-replies, classifies urgency, gathers info. You get an SMS alert if urgent/emergency. Open dashboard to review when ready.

### Log a payment
Dashboard → Payments → Log payment. Pick tenant, amount, type, month.

### Utility bill
Dashboard → Utilities → Add bill → select type → Calculate → Save & notify. Agent texts both tenants automatically.

### Schedule cleaning
Dashboard → Scheduling → Schedule Cleaning. Agent texts tenants for availability, proposes times to you, you approve, agent confirms with Stanley/Dazzling and notifies tenants.

### Schedule pest control
Same as cleaning but agent texts Mehmet directly to confirm.

### Thumbtack job
Dashboard → Scheduling → Thumbtack Draft → describe issue → copy to Thumbtack → hire someone → enter their details → agent schedules with tenants.

### Add a new tenant (future)
Dashboard → Settings → Add new tenant → fill in details. They'll be included in all future broadcasts and reminders automatically.

### Update agent behavior
Dashboard → Settings → Edit any instruction field → Save. Takes effect immediately.

## File structure

```
property-agent/
├── src/
│   ├── server.js          # Express server + all API routes
│   ├── db.js              # SQLite database + schema
│   ├── agent.js           # Claude AI agent logic
│   ├── twilio-handler.js  # SMS in/out, rent reminders, late fees
│   └── scheduler.js       # Cleaning, pest control, Thumbtack scheduling
├── public/
│   └── index.html         # Dashboard web app
├── data/                  # SQLite database (auto-created)
├── .env.example           # Environment variable template
├── package.json
└── README.md
```

## Scheduled jobs (automatic)

- **Daily 9am**: checks if tomorrow is the 1st → sends rent reminders to tenants who haven't paid
- **Daily 9am**: checks if today is the 6th → sends late fee notices to tenants past grace period  
- **Daily 9am**: checks for any day-before service reminders to send

## Cost estimate

- Railway: free tier (~$0/month for your volume)
- Twilio: ~$1.15/month for phone number + ~$0.008/text ≈ $2-3/month total
- Anthropic: ~$0.003 per conversation ≈ $1-2/month total
- **Total: ~$4-5/month**
