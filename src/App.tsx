import { Routes, Route } from "react-router-dom";
import { LoginPage } from "./features/auth/LoginPage";
import { ProtectedRoute } from "./features/auth/ProtectedRoute";
import { AppLayout } from "./pages/AppLayout";
import { WelcomePage } from "./pages/WelcomePage";
import { RoomPage } from "./pages/RoomPage";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<WelcomePage />} />
        <Route path="/rooms/:roomId" element={<RoomPage />} />
      </Route>
    </Routes>
  );
}
