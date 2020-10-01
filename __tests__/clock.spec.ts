import TestEnvoirnment from "../TestEnviroment"
import ClockPage from "../Pages/ClockPage"

beforeAll(()=>{
    return TestEnvoirnment.setup();
})

afterAll(()=>{
    return TestEnvoirnment.teardown();
})

describe('Clock Automation and Testing', ()=>{
    test('Set Alarm', async()=>{
        await ClockPage.clockTab.click();
        await ClockPage.alarmTab.click();
        await ClockPage.clockTab.click();
        await ClockPage.alarmTab.click();
        await ClockPage.addAlarmButton.click();
        await ClockPage.alarmSaveButton.click();
    })
})