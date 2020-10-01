import { PageObject, By2 } from "selenium-appium"

class ClockPage extends PageObject {
    get alarmTab() { return By2.nativeName("Alarm") }
    get clockTab() { return By2.nativeAccessibilityId("ClockButton") }
    get addAlarmButton() { return By2.nativeXpath("//AppBarButton[@Name='Add new alarm']") }
    // get addAlarmButton() { return By2.nativeAccessibilityId("AddAlarmButton") }
    // get addAlarmButton() { return By2.nativeName("Add new alarm") }
    get alarmSaveButton() { return By2.nativeAccessibilityId("AlarmSaveButton") }
}

export default new ClockPage();