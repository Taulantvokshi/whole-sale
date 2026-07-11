import path from "path";
import express from "express";
import { config } from "./config";
import { cors } from "./middleware/cors";
import { errorHandler } from "./middleware/errorHandler";
import { usersRouter } from "./modules/users/users.routes";
import { shopifyRouter } from "./modules/shopify/shopify.routes";
import { buyersRouter } from "./modules/buyers/buyers.routes";
import { templatesRouter } from "./modules/templates/templates.routes";
import { ordersRouter } from "./modules/orders/orders.routes";

const app = express();

// Global middleware.
app.use(cors);
app.use(express.json());
// Serve the static HTML page where the merchant starts the install.
app.use(express.static(path.join(__dirname, "..", "public")));

// Feature routers.
app.use(usersRouter);
app.use(shopifyRouter);
app.use(buyersRouter);
app.use(templatesRouter);
app.use(ordersRouter);

// Central error handler — must come after all routers.
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`Server running at ${config.host}`);
});
