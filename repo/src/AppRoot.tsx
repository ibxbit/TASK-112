import React from "react";
import { Provider } from "react-redux";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { GlobalErrorBoundary } from "./components/GlobalErrorBoundary";
import { store } from "./store";

export default function AppRoot(): JSX.Element {
  return (
    <Provider store={store}>
      <GlobalErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </GlobalErrorBoundary>
    </Provider>
  );
}
