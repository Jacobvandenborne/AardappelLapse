# AardappelLapse

AardappelLapse is an Expo-based React Native application featuring a camera interface.

## Getting Started

### Prerequisites

- Node.js installed on your machine.
- Expo Go app installed on your physical device (Android or iOS), or an emulator set up.

### Installation

1.  Navigate to the project directory:
    ```bash
    cd AardappelLapse
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

### Running the App

1.  Start the development server:
    ```bash
    npx expo start
    ```

2.  Running on your device:
    -   **Android**: Scan the QR code using the Expo Go app.
    -   **iOS**: Open the Camera app and scan the QR code to open in Expo Go.

3.  Running on Emulator/Simulator:
    -   Press `a` to open on Android Emulator.
    -   Press `i` to open on iOS Simulator.

## Features

-   **Home Screen**: Navigation button to access the camera.
-   **Camera Screen**: Full-screen camera view with toggle functionality.

## Troubleshooting

### Windows PowerShell Error
If you encounter a security error regarding script execution policies (e.g., `PSSecurityException`), run the following command instead:

```powershell
cmd /c "npx expo start"
```

Or, enable script execution for the current session:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### ConfigError: package.json does not exist
If you see an error like `ConfigError: The expected package.json path: ... does not exist`, it means you are in the wrong folder. Make sure to navigate to the project folder first:

```bash
cd AardappelLapse
```

### iOS Connection Issues
On iOS, the Expo Go app no longer has a built-in QR scanner due to Apple restrictions.

**The most reliable method:**
1.  **Log in to your Expo account** in the terminal:
    ```bash
    npx expo login
    ```
2.  **Log in to the Expo Go app** on your iPhone with the same account.
3.  Your project will automatically appear under **"Recently in development"** in the app. Tap it to open.

**Alternative (Tunnel):**
If you still want to scan a QR code, you must use the **standard Camera app** on your iPhone (not Expo Go). If it fails, try using the tunnel connection:
    ```bash
    npx expo start --tunnel
    ```
