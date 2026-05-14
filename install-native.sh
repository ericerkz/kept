#!/bin/bash

# This is the NATIVE installer (Node.js + optional systemd service).
# If you want Docker instead: docker compose up -d --build  (see README).

# Ensure running as root for systemd installation if requested
set -e

# Yellow body with a blue top-left shadow, mirroring the navbar logo style.
Y=$'\033[38;5;229m'
B=$'\033[38;5;111m'
R=$'\033[0m'
printf "%b" "${B} ▄▄   ▄▄ ▄▄▄▄▄ ▄▄▄▄  ▄▄▄▄▄${R}\n"
printf "%b" "${Y} ██╗  ██╗${B}▄${Y}███████╗██████╗ ████████╗${R}\n"
printf "%b" "${Y} ██║ ██╔╝██╔════╝██╔══██╗╚══██╔══╝${R}\n"
printf "%b" "${Y} █████╔╝ █████╗  ██████╔╝   ██║   ${R}\n"
printf "%b" "${Y} ██╔═██╗ ██╔══╝  ██╔═══╝    ██║   ${R}\n"
printf "%b" "${Y} ██║  ██╗███████╗██║        ██║   ${R}\n"
printf "%b" "${Y} ╚═╝  ╚═╝╚══════╝╚═╝        ╚═╝   ${R}\n"
echo ""
echo "          ${Y}Kept Installer${R}"
echo "        ${B}www.keepitkept.xyz${R}"
echo ""

# Check Node version, install if missing
install_node() {
    echo "Node.js v24 not found. Attempting to install..."
    local os_name="$(uname -s)"

    if [ "$os_name" = "Darwin" ]; then
        if command -v brew &> /dev/null; then
            echo "Installing via Homebrew..."
            brew install node@24 && brew link --overwrite --force node@24
            return $?
        fi
        echo "Error: Homebrew not found. Install Homebrew (https://brew.sh) or Node.js v24 manually, then rerun."
        return 1
    fi

    # Linux: try NodeSource (covers Debian/Ubuntu/RHEL/Fedora). Needs sudo + curl.
    if [ "$os_name" = "Linux" ]; then
        if ! command -v curl &> /dev/null; then
            echo "Error: curl is required to install Node.js automatically. Install curl, or install Node.js v24 manually, then rerun."
            return 1
        fi
        local sudo_cmd=""
        if [ "$EUID" -ne 0 ]; then
            if command -v sudo &> /dev/null; then sudo_cmd="sudo"
            else
                echo "Error: This script needs root (or sudo) to install Node.js. Rerun with sudo, or install Node.js v24 manually."
                return 1
            fi
        fi

        if command -v apt-get &> /dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_24.x | $sudo_cmd -E bash - && $sudo_cmd apt-get install -y nodejs
            return $?
        fi
        if command -v dnf &> /dev/null; then
            curl -fsSL https://rpm.nodesource.com/setup_24.x | $sudo_cmd bash - && $sudo_cmd dnf install -y nodejs
            return $?
        fi
        if command -v yum &> /dev/null; then
            curl -fsSL https://rpm.nodesource.com/setup_24.x | $sudo_cmd bash - && $sudo_cmd yum install -y nodejs
            return $?
        fi
        echo "Error: No supported package manager (apt-get/dnf/yum) found. Install Node.js v24 manually, then rerun."
        return 1
    fi

    echo "Error: Unsupported OS ($os_name). Install Node.js v24 manually, then rerun."
    return 1
}

if ! command -v node &> /dev/null; then
    if ! install_node; then
        echo "Error: Node.js v24 install failed. The app requires Node.js v24.x; if your OS does not support an automated install, install it manually and rerun this script."
        exit 1
    fi
fi

NODE_VER=$(node -v | grep -oE '[0-9]+' | head -1)
if [ "$NODE_VER" -lt 24 ]; then
    echo "Warning: Node.js v24 or higher is required. Found: $(node -v)"
    echo "Attempting to upgrade Node.js..."
    if ! install_node; then
        echo "Could not upgrade Node.js automatically. Press Enter to continue with the current version anyway, or Ctrl+C to abort."
        read
    fi
fi

echo "1. Installing dependencies..."
npm install

echo "2. Building the Angular application..."
npm run build

echo ""
echo "Installation complete!"
echo "You can start the app manually at any time by running:"
echo "PORT=6767 npm run api"
echo ""

read -p "Would you like to install this as a systemd service to run on boot? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    if [ "$EUID" -ne 0 ]; then
        echo "Error: You must run this script with sudo to configure a systemd service."
        echo "Please re-run this script with sudo, or set up the service manually."
        exit 1
    fi

    SERVICE_FILE="/etc/systemd/system/kept.service"
    USER_NAME=$(logname || echo $SUDO_USER || echo $USER)
    WORK_DIR=$(pwd)
    
    echo "Creating systemd service at $SERVICE_FILE..."
    cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Kept API
After=network.target

[Service]
Environment=PORT=6767
Environment=NODE_ENV=production
Type=simple
User=$USER_NAME
WorkingDirectory=$WORK_DIR
ExecStart=$(command -v node) server/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

    echo "Reloading systemd daemon..."
    systemctl daemon-reload
    echo "Enabling service to start on boot..."
    systemctl enable kept
    echo "Starting service..."
    systemctl start kept
    
    echo "Service installed and started! You can check its status with:"
    echo "systemctl status kept"
    echo "The application is running at http://localhost:6767"
else
    echo "Skipping system service setup."
    echo "The application is ready. Run 'PORT=6767 npm run api' to start."
fi
