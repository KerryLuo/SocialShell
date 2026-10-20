import { test,expect } from "@playwright/test";
import { freshDemo } from "../../lib/seeds";
import type { CampusItem } from "../../lib/types";
const item:CampusItem={id:"snowflake:group:22",kind:"group",title:"Shared Coding Club",description:"Find coding friends",tags:["AI"],location:"Iribe",meetingDetails:"Fridays",date:"",time:"",demo:false,color:0,createdAt:"2026-10-04T12:00:00Z",isActive:true};
test("live workspace saves profiles and swipes through the server and reloads them",async({page})=>{
 const state={...freshDemo(),items:[item]};
 await page.route("**/api/state",route=>route.fulfill({json:{mode:"snowflake",state}}));
 await page.route("**/api/profile",async route=>{state.profile=route.request().postDataJSON();await route.fulfill({json:{profile:state.profile}});});
 await page.route("**/api/swipes",async route=>{const body=route.request().postDataJSON();state.decisions[body.id]=body.decision;await route.fulfill({json:{saved:true}});});
 await page.goto("/profile");
 await expect(page.getByText("Shared campus catalog")).toBeVisible();
 await page.getByLabel("Display name").fill("Aayush");
 await page.getByRole("button",{name:"Save profile"}).click();
 await expect(page.getByText("Profile saved to Snowflake.",{exact:false})).toBeVisible();
 await page.reload();await expect(page.getByLabel("Display name")).toHaveValue("Aayush");
 await page.goto("/discover");await page.getByRole("button",{name:"Interested",exact:true}).click();
 await expect(page.getByRole("heading",{name:"You made the rounds."})).toBeVisible();
 await page.goto("/saved");await expect(page.getByRole("heading",{name:item.title})).toBeVisible();
 await page.reload();await expect(page.getByRole("heading",{name:item.title})).toBeVisible();
});
test("published groups use the API and failed writes do not claim success",async({page})=>{
 const state={...freshDemo(),items:[] as CampusItem[]};
 await page.route("**/api/state",route=>route.fulfill({json:{mode:"snowflake",state}}));
 let fail=true;
 await page.route("**/api/items",async route=>{
  const body=route.request().postDataJSON();expect(body.key).toMatch(/^[0-9a-f-]{36}$/);
  if(fail)await route.fulfill({status:502,json:{error:"Publish failed; retry."}});
  else {state.items.push(item);await route.fulfill({json:{item}});}
 });
 await page.goto("/create");await page.getByRole("button",{name:"Create a group"}).click();
 await page.getByLabel("Group name").fill(item.title);await page.getByLabel("Description",{exact:true}).fill(item.description);
 await page.getByRole("button",{name:"Publish group"}).click();await expect(page.getByRole("main").getByRole("alert")).toContainText("Publish failed");
 await expect(page.getByText("is published!",{exact:false})).toHaveCount(0);
 fail=false;await page.getByRole("button",{name:"Publish group"}).click();await expect(page.getByText("is published!",{exact:false})).toBeVisible();
 await page.goto("/discover");await expect(page.getByRole("heading",{name:item.title})).toBeVisible();
});
test("backend load errors do not silently switch to browser demo data",async({page})=>{
 await page.route("**/api/state",route=>route.fulfill({status:503,json:{error:"Database unavailable"}}));
 await page.goto("/discover");await expect(page.getByRole("main").getByRole("alert")).toContainText("Database unavailable");
 await expect(page.getByRole("heading",{name:"The Debug Club"})).toHaveCount(0);
});

test("backend API keeps local mode explicit and rejects writes when disabled",async({request})=>{
 const state=await request.get("/api/state");expect(state.status()).toBe(200);expect(await state.json()).toEqual({mode:"local"});
 for(const endpoint of ["items","profile","swipes","reset"]){const response=await request.post(`/api/${endpoint}`,{data:{}});expect(response.status()).toBe(503);expect(await response.json()).toHaveProperty("error");}
});
test("live swipes advance without waiting for Snowflake and roll back if the save fails",async({page})=>{
 const second:CampusItem={...item,id:"snowflake:group:23",title:"Second Club"};
 const state={...freshDemo(),items:[item,second]};
 await page.route("**/api/state",route=>route.fulfill({json:{mode:"snowflake",state}}));
 let release!:()=>void;const slow=new Promise<void>(resolve=>{release=resolve;});
 await page.route("**/api/swipes",async route=>{await slow;await route.fulfill({status:502,json:{error:"Swipe could not be saved."}});});
 await page.goto("/discover");
 await expect(page.getByRole("heading",{name:item.title})).toBeVisible();
 await page.getByRole("button",{name:"Interested",exact:true}).click();
 // The server has not answered yet, but the next card is already up.
 await expect(page.getByRole("heading",{name:second.title})).toBeVisible();
 release();
 await expect(page.getByText("Swipe could not be saved.")).toBeVisible();
 await expect(page.getByRole("heading",{name:item.title})).toBeVisible();
});
