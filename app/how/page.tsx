import { redirect } from "next/navigation";

// "How grading works" now lives on the About page.
export default function How() {
  redirect("/about#grading");
}
