# Rebase

## Setup Overview

Rebase supports two development workflows:

- **Standard setup:** Uses `uv`, Node.js, and locally installed services. Nix is not required.
- **Nix setup:** Uses the provided Nix Flake and direnv configuration for a reproducible development environment.

Both workflows use the same backend and frontend commands.

---

## Option 1: Standard Setup (Without Nix)

### Prerequisites

- Python 3.13+
- [uv](https://docs.astral.sh/uv/)
- Node.js 22+
- PostgreSQL 16+
- Redis

Ensure PostgreSQL and Redis are installed, running, and configured for your local environment.

### 1. Backend Setup

Navigate to the backend directory:

```bash
cd backend
```

Create the virtual environment and install dependencies:

```bash
uv sync
```

Activate the virtual environment:

```bash
source .venv/bin/activate
```

Run database migrations once database configuration is implemented:

```bash
python manage.py migrate
```

Start the Django development server:

```bash
python manage.py runserver
```

### 2. Frontend Setup

Open a separate terminal and navigate to the frontend directory:

```bash
cd frontend
```

Install dependencies:

```bash
npm install
```

Start the Vite development server:

```bash
npm run dev
```

---

## Option 2: Reproducible Setup (Using Nix)

Rebase includes a Nix Flake that provides a consistent development environment.

### Prerequisites

- [Nix](https://nixos.org/) with Flakes enabled
- [direnv](https://direnv.net/) (optional, for automatic environment activation)

### 1. Enter the Development Environment

From the repository root:

```bash
nix develop
```

If direnv is configured, the development environment activates automatically when entering the repository.

### 2. Start the Backend

```bash
cd backend
uv sync
uv run python manage.py runserver
```

### 3. Start the Frontend

In a separate terminal:

```bash
cd frontend
npm install
npm run dev
```

---

## Quality Assurance & Linting

Rebase provides a repository-level check script for running the project's quality checks.

From the repository root:

```bash
./scripts/check.sh
```

The script runs:

- **Ruff:** Python linting
- **basedpyright:** Python static type checking
- **pytest:** Python tests
- **TypeScript:** Frontend type checking
- **Vitest:** Frontend tests

All checks should pass before submitting changes.

---

## Project Structure

```text
rebase/
├── backend/          # Django and Channels backend
├── frontend/         # React, TypeScript, and Vite frontend
├── scripts/          # Development and quality-assurance scripts
├── flake.nix         # Reproducible Nix development environment
├── flake.lock        # Locked Nix dependencies
├── .env.example      # Environment variable template
├── .envrc            # direnv configuration
└── README.md
```
