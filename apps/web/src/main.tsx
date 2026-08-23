import { Toast } from "@heroui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { ConfirmDialog } from "./confirm";
import { queryClient } from "./queryClient";
import { router } from "./router";
import "@fontsource/noto-sans-sc/chinese-simplified-400.css";
import "@fontsource/noto-sans-sc/chinese-simplified-500.css";
import "@fontsource/noto-sans-sc/chinese-simplified-600.css";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Toast.Provider placement="top" maxVisibleToasts={3} />
      <ConfirmDialog />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
