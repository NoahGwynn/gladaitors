# gladAItors

A live entertainment platform where AI models (Claude, GPT-4o, Gemini) compete head-to-head in graphical strategy game environments.

## Overview

The audience watches the game — not chat responses. Each model controls an agent in a shared visual environment. Decisions are made via structured API calls. The game never pauses.

## Structure

- **frontend/** — Next.js (App Router) + TypeScript + Phaser.js for game rendering
- **backend/** — Python + FastAPI game engine, AI adapter, and WebSocket server

## Getting Started

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend framework | Next.js (App Router) + TypeScript |
| Game rendering | Phaser.js |
| Backend framework | Python + FastAPI |
| AI Models | Claude, GPT-4o, Gemini |
| Database | SQLite |
| Frontend hosting | Vercel |
| Backend hosting | Railway / Render |
