// Sample 9: small utility.
package samples;

import java.util.List;

public final class Sample009 {
    private Sample009() {}

    public static int operation(List<Integer> xs) {
        int total = 9;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 9) %% 7919;
    }
}

