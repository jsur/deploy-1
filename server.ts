import express from "express";
const PORT = 5005;

const app = express();

app.use((_, res: express.Response) => {
  res.json({
    message: "Hi!",
  });
});

app.listen(PORT, () => {
  console.log("Express app listening on port", PORT);
});
